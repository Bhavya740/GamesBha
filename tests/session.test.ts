import { describe, expect, it } from "vitest";
import type { GameMessage } from "../src/games/dotsandboxes";
import { meta } from "../src/games/dotsandboxes/meta";
import { DEFAULT_GEOMETRY, applyMove, makeGeometry, newBoard, type Geometry, type Player } from "../src/games/dotsandboxes/logic";
import {
  createSession,
  localLeave,
  localMove,
  localRematch,
  messageBytes,
  receive,
  startMessage,
  type Session,
  type Step,
} from "../src/games/dotsandboxes/session";

/**
 * Simulated Gulaab bridge: FIFO, JSON round-tripped, optional duplication.
 * (A constant 150 ms delay preserves order, so FIFO is an exact model.)
 */
class Net {
  s: Record<Player, Session>;
  queue: { to: Player; msg: unknown }[] = [];
  sent: GameMessage[] = [];
  duplicate = false;

  constructor(geo: Geometry = DEFAULT_GEOMETRY) {
    this.s = { host: createSession("host", geo), guest: createSession("guest", geo) };
  }
  private apply(side: Player, step: Step) {
    this.s[side] = step.session;
    for (const m of step.out) {
      this.sent.push(m);
      const to: Player = side === "host" ? "guest" : "host";
      const copy = JSON.parse(JSON.stringify(m));
      this.queue.push({ to, msg: copy });
      if (this.duplicate) this.queue.push({ to, msg: JSON.parse(JSON.stringify(m)) });
    }
  }
  hello(side: Player) {
    this.apply(side, { session: this.s[side], out: [startMessage(this.s[side])] });
  }
  move(side: Player, edge: number) {
    this.apply(side, localMove(this.s[side], edge));
  }
  rematch(side: Player) {
    this.apply(side, localRematch(this.s[side]));
  }
  leave(side: Player) {
    this.apply(side, localLeave(this.s[side]));
  }
  inject(to: Player, msg: unknown) {
    this.queue.push({ to, msg });
  }
  flush() {
    let guard = 0;
    while (this.queue.length) {
      if (++guard > 10_000) throw new Error("message storm");
      const { to, msg } = this.queue.shift()!;
      this.apply(to, receive(this.s[to], msg));
    }
  }
  expectInSync() {
    const { host, guest } = this.s;
    expect(guest.round).toBe(host.round);
    expect(guest.moves).toEqual(host.moves);
    expect(guest.board).toEqual(host.board);
  }
  /** Plays until the round is over, always moving for whoever's turn it is. */
  playOut(pick: (open: number[]) => number = (o) => o[0]) {
    while (!this.s.host.board.over) {
      const side = this.s.host.board.turn;
      const open = this.s[side].board.edges.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0);
      this.move(side, pick(open));
      this.flush();
      this.expectInSync();
    }
  }
}

const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

describe("protocol", () => {
  it("handshake: both send start, both reply once, no message storm", () => {
    const net = new Net();
    net.hello("host");
    net.hello("guest");
    net.flush();
    expect(net.sent.filter((m) => m.action === "start")).toHaveLength(4);
    expect(net.s.host.peerPresent && net.s.guest.peerPresent).toBe(true);
    net.expectInSync();
  });

  it("host moves first in round 1; guest cannot move out of turn", () => {
    const net = new Net();
    expect(net.s.host.board.turn).toBe("host");
    net.move("guest", 0); // not guest's turn → ignored locally, nothing sent
    expect(net.sent).toHaveLength(0);
    net.move("host", 0);
    net.flush();
    expect(net.s.guest.board.edges[0]).toBe(1);
    expect(net.s.guest.board.turn).toBe("guest");
    net.move("guest", 7);
    net.flush();
    expect(net.s.host.board.edges[7]).toBe(2);
    expect(net.s.host.board.turn).toBe("host");
    net.expectInSync();
  });

  it("extra turn after a box, and a double box from one line, stay in sync", () => {
    const net = new Net();
    for (const [side, e] of [["host", 0], ["guest", 5], ["host", 30], ["guest", 31]] as const) {
      net.move(side, e);
      net.flush();
    }
    expect(net.s.host.board.scores.guest).toBe(1);
    expect(net.s.host.board.turn).toBe("guest"); // extra turn
    net.expectInSync();

    const n2 = new Net();
    for (const [side, e] of [["host", 0], ["guest", 5], ["host", 30], ["guest", 1], ["host", 6], ["guest", 32], ["host", 31]] as const) {
      n2.move(side, e);
      n2.flush();
    }
    expect(n2.s.guest.board.scores).toEqual({ host: 2, guest: 0 });
    expect(n2.s.guest.board.turn).toBe("host");
    n2.expectInSync();
  });

  it("rejects forged out-of-turn moves and already-drawn lines from the peer", () => {
    const net = new Net();
    // It's host's turn; a "guest" move arriving at host must be ignored.
    net.inject("host", { action: "move", round: 1, n: 0, edge: 3 });
    net.flush();
    expect(net.s.host.moves).toEqual([]);
    net.move("host", 3);
    net.flush();
    // Guest's turn now; a move on an already-drawn line is ignored.
    net.inject("host", { action: "move", round: 1, n: 1, edge: 3 });
    net.flush();
    expect(net.s.host.moves).toEqual([3]);
    expect(net.s.host.board.turn).toBe("guest");
  });

  it("ignores duplicate messages (every message delivered twice)", () => {
    const net = new Net();
    net.duplicate = true;
    net.hello("host");
    net.hello("guest");
    net.flush();
    net.playOut();
    net.rematch("host");
    net.rematch("guest");
    net.flush();
    net.expectInSync();
    expect(net.s.host.round).toBe(2); // not 3: the duplicated rematch was ignored
    expect(net.s.guest.board.turn).toBe("guest");
  });

  it("rejects malformed and unknown messages without changing state", () => {
    const net = new Net();
    net.move("host", 0);
    net.flush();
    const before = JSON.stringify(net.s.guest);
    const bad: unknown[] = [
      null, undefined, 42, "move", [], [1, 2],
      {}, { action: 5 }, { action: "explode" }, { action: "__proto__" },
      { action: "move" },
      { action: "move", round: 1, n: 1, edge: 60 },
      { action: "move", round: 1, n: 1, edge: -1 },
      { action: "move", round: 1, n: 1, edge: 2.5 },
      { action: "move", round: 1, n: 1, edge: "2" },
      { action: "move", round: 1, n: -1, edge: 2 },
      { action: "move", round: 0, n: 1, edge: 2 },
      { action: "move", round: 1, n: 1, edge: null },
      { action: "rematch" }, { action: "rematch", round: "1" }, { action: "rematch", round: 1 }, // game not over
      { action: "start", round: 1, moves: "x", reply: false },
      { action: "start", round: 1, moves: [0, 0], reply: true }, // invalid history (line drawn twice)
      { action: "start", round: 1, moves: [999], reply: true },
      { action: "start", round: 1, moves: new Array(61).fill(0), reply: true },
      { action: "start", round: 1, moves: [0], reply: "no" },
    ];
    for (const m of bad) net.inject("guest", m);
    net.flush();
    const after = JSON.parse(JSON.stringify(net.s.guest));
    const was = JSON.parse(before);
    // Only "rematch round 1" may set peerRematch (harmless, game not over); board must be untouched.
    expect(after.board).toEqual(was.board);
    expect(after.moves).toEqual(was.moves);
    expect(after.round).toBe(1);
    expect(net.s.guest.peerLeft).toBe(false);
  });

  it("plays complete games: win detected identically on both sides", () => {
    const r = rng(42);
    for (let g = 0; g < 20; g++) {
      const net = new Net();
      net.hello("host");
      net.hello("guest");
      net.flush();
      net.playOut((open) => open[Math.floor(r() * open.length)]);
      const b = net.s.guest.board;
      expect(b.over).toBe(true);
      expect(b.scores.host + b.scores.guest).toBe(25);
      expect(b.winner).not.toBe("draw");
      expect(b.winner).toBe(b.scores.host > b.scores.guest ? "host" : "guest");
    }
  });

  it("detects a draw on both sides (even board, 2 × 2)", () => {
    const g2 = makeGeometry(2, 2);
    // Find a move order that ends 2–2.
    const r = rng(3);
    let order: number[] = [];
    for (;;) {
      let b = newBoard(g2, 1);
      order = [];
      while (!b.over) {
        const open = b.edges.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0);
        const e = open[Math.floor(r() * open.length)];
        order.push(e);
        b = applyMove(g2, b, e)!;
      }
      if (b.winner === "draw") break;
    }
    const net = new Net(g2);
    let i = 0;
    net.playOut(() => order[i++]);
    expect(net.s.host.board.winner).toBe("draw");
    expect(net.s.guest.board.winner).toBe("draw");
  });

  it("rematch needs both players, and the first player alternates every round", () => {
    const net = new Net();
    const starters: Player[] = [];
    for (let round = 1; round <= 4; round++) {
      expect(net.s.host.round).toBe(round);
      starters.push(net.s.host.board.turn);
      net.playOut();
      const first: Player = round % 2 ? "guest" : "host";
      net.rematch(first);
      net.flush();
      expect(net.s.host.round).toBe(round); // waiting for the other player
      expect(net.s[first === "host" ? "guest" : "host"].peerRematch).toBe(true);
      net.rematch(first === "host" ? "guest" : "host");
      net.flush();
      net.expectInSync();
    }
    expect(starters).toEqual(["host", "guest", "host", "guest"]);
  });

  it("simultaneous rematch taps advance exactly one round", () => {
    const net = new Net();
    net.playOut();
    net.rematch("host");
    net.rematch("guest");
    net.flush();
    net.expectInSync();
    expect(net.s.host.round).toBe(2);
    expect(net.s.host.board.turn).toBe("guest");
  });

  it("rematch is not possible before the game is over", () => {
    const net = new Net();
    net.move("host", 0);
    net.rematch("host");
    net.flush();
    expect(net.sent.some((m) => m.action === "rematch")).toBe(false);
  });

  it("player leaving mid-game blocks further play; re-opening starts fresh", () => {
    const net = new Net();
    net.move("host", 0);
    net.move("host", 1); // not host's turn any more → ignored
    net.flush();
    net.leave("guest");
    net.flush();
    expect(net.s.host.peerLeft).toBe(true);
    net.move("host", 2); // it is guest's turn anyway; also peer left
    net.inject("host", { action: "move", round: 1, n: 1, edge: 9 }); // late move after leave → ignored
    net.flush();
    expect(net.s.host.moves).toEqual([0]);

    // Guest re-opens the game: brand-new session says hello.
    net.s.guest = createSession("guest", DEFAULT_GEOMETRY);
    net.hello("guest");
    net.flush();
    expect(net.s.host.peerLeft).toBe(false);
    expect(net.s.host.round).toBe(1);
    expect(net.s.host.moves).toEqual([]);
    net.expectInSync();
  });

  it("a copy that (re)mounts mid-game catches up via start / reply", () => {
    const net = new Net();
    net.hello("host");
    net.hello("guest");
    net.flush();
    for (const [side, e] of [["host", 0], ["guest", 5], ["host", 30]] as const) {
      net.move(side, e);
      net.flush();
    }
    // Guest component remounts (e.g. app re-render) without leaving.
    net.s.guest = createSession("guest", DEFAULT_GEOMETRY);
    net.hello("guest");
    net.flush();
    net.expectInSync();
    expect(net.s.guest.board.turn).toBe("guest");
  });

  it("a guest that missed a move requests a resync instead of desyncing", () => {
    const net = new Net();
    net.move("host", 0);
    net.queue = []; // the move is lost in transit
    net.move("guest", 1); // guest still thinks it's host's turn → ignored locally
    expect(net.queue).toHaveLength(0);
    // Host plays on (can't: it's guest's turn). Simulate guest getting a later round message instead.
    net.inject("guest", { action: "move", round: 1, n: 3, edge: 9 }); // gap → resync request
    net.flush();
    net.expectInSync();
    expect(net.s.guest.moves).toEqual([0]);
  });

  it("every message is < 512 bytes and uses only actions declared in meta.actions", () => {
    const net = new Net();
    net.hello("host");
    net.hello("guest");
    net.flush();
    net.playOut();
    net.rematch("host");
    net.rematch("guest");
    net.flush();
    net.playOut();
    // Worst case: a start message carrying a full 60-move history.
    net.hello("host");
    net.flush();
    net.leave("guest");
    net.flush();
    for (const m of net.sent) {
      expect(meta.actions).toContain(m.action);
      expect(messageBytes(m)).toBeLessThan(512);
    }
    const biggest = Math.max(...net.sent.map(messageBytes));
    expect(biggest).toBeGreaterThan(150); // the full-history start was measured
    expect(new Set(net.sent.map((m) => m.action))).toEqual(new Set(meta.actions));
  });
});
