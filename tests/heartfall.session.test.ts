import { describe, expect, it } from "vitest";
import type { GameMessage } from "../src/games/dont-break-the-heart";
import { meta } from "../src/games/dont-break-the-heart/meta";
import {
  FRAGILE_COUNT,
  PIECE_COUNT,
  generateFragile,
  replay,
  starterForRound,
  type Config,
  type Player,
} from "../src/games/dont-break-the-heart/logic";
import {
  canTap,
  createState,
  guestResync,
  localLeave,
  localRematch,
  localTap,
  messageBytes,
  mountMessage,
  receive,
  scoresOf,
  type HostEnv,
  type State,
  type Step,
} from "../src/games/dont-break-the-heart/session";

const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const otherSide = (p: Player): Player => (p === "host" ? "guest" : "host");

/** Deterministic host env: scripted fragile sets, increasing game ids. */
function makeEnv(fragiles: number[][] = [], seed = 1): HostEnv {
  let id = 1_000;
  const r = rng(seed);
  const queue = fragiles.slice();
  return { newGameId: () => (id += 1_000), newFragile: () => queue.shift() ?? generateFragile(r) };
}

class Net {
  s: Record<Player, State>;
  env: HostEnv;
  queue: { to: Player; msg: unknown }[] = [];
  sent: { from: Player; msg: GameMessage }[] = [];
  duplicate = false;

  constructor(env = makeEnv()) {
    this.env = env;
    this.s = { host: createState("host", env), guest: createState("guest") };
  }
  private apply(side: Player, step: Step) {
    this.s[side] = step.state;
    for (const m of step.out) {
      expect(messageBytes(m)).toBeLessThan(512);
      expect(meta.actions).toContain(m.action);
      this.sent.push({ from: side, msg: m });
      const to = otherSide(side);
      this.queue.push({ to, msg: JSON.parse(JSON.stringify(m)) });
      if (this.duplicate) this.queue.push({ to, msg: JSON.parse(JSON.stringify(m)) });
    }
  }
  mount(side: Player) {
    this.apply(side, { state: this.s[side], out: [mountMessage(this.s[side])] });
  }
  tap(side: Player, piece: number) {
    this.apply(side, localTap(this.s[side], piece));
  }
  rematch(side: Player) {
    this.apply(side, localRematch(this.s[side], side === "host" ? this.env : undefined));
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
      this.apply(to, receive(this.s[to], msg, to === "host" ? this.env : undefined));
    }
  }
  begin() {
    this.mount("host");
    this.mount("guest");
    this.flush();
  }
  expectInSync() {
    const { host: h, guest: g } = this.s;
    expect(g.cfg).toEqual(h.cfg);
    expect(g.moves).toEqual(h.moves);
    expect(g.board).toEqual(h.board);
    expect(scoresOf(g)).toEqual(scoresOf(h));
  }
  /** Whoever's turn it is taps `pick(open)`; confirms through the host. */
  step(pick: (open: number[]) => number) {
    const side = this.s.host.board!.turn;
    const open = this.s[side].board!.used.map((u, i) => (u ? -1 : i)).filter((i) => i >= 0);
    this.tap(side, pick(open));
    this.flush();
    this.expectInSync();
  }
  playOut(pick: (open: number[]) => number = (o) => o[0]) {
    while (!this.s.host.board!.over) this.step(pick);
  }
}

describe("Heartfall rules", () => {
  it("12 pieces, 3 fragile, generated as distinct indices", () => {
    const r = rng(9);
    for (let i = 0; i < 200; i++) {
      const f = generateFragile(r);
      expect(f).toHaveLength(FRAGILE_COUNT);
      expect(new Set(f).size).toBe(3);
      expect(f.every((x) => x >= 0 && x < PIECE_COUNT)).toBe(true);
    }
  });

  it("safe pieces disappear, fragile ones crack, the 3rd crack breaks the heart", () => {
    const cfg: Config = { gameId: 1, round: 1, fragile: [2, 5, 9], firstPlayer: "host" };
    let b = replay(cfg, [0])!; // host, safe
    expect(b.used[0]).toBe(true);
    expect(b.cracks).toBe(0);
    expect(b.remaining).toBe(11);
    expect(b.turn).toBe("guest");
    b = replay(cfg, [0, 2])!; // guest, fragile
    expect(b.cracks).toBe(1);
    expect(b.crackedPieces).toEqual([2]);
    expect(b.turn).toBe("host"); // turn passes even after a crack
    b = replay(cfg, [0, 2, 5])!; // host, 2nd crack
    expect(b.over).toBe(false);
    b = replay(cfg, [0, 2, 5, 1, 9])!; // host breaks it
    expect(b.over).toBe(true);
    expect(b.result).toEqual({ kind: "break", loser: "host", winner: "guest" });
    expect(replay(cfg, [0, 2, 5, 1, 9, 3])).toBeNull(); // no moves after the break
    expect(replay(cfg, [0, 0])).toBeNull(); // used piece
  });

  it("draw: all pieces removed without a 3rd crack (only reachable with < 3 fragile pieces)", () => {
    // With exactly 3 fragile pieces among 12 a draw cannot happen (all 12 get picked).
    const cfg: Config = { gameId: 1, round: 1, fragile: [4, 7], firstPlayer: "host" };
    const b = replay(cfg, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])!;
    expect(b.cracks).toBe(2);
    expect(b.over).toBe(true);
    expect(b.result).toEqual({ kind: "draw" });
    // …and with the real rules every full game ends with a break.
    const r = rng(5);
    for (let g = 0; g < 200; g++) {
      const c: Config = { gameId: 1, round: 1, fragile: generateFragile(r), firstPlayer: "host" };
      const order = Array.from({ length: 12 }, (_, i) => i).sort(() => r() - 0.5);
      let moves: number[] = [];
      for (const p of order) {
        moves = [...moves, p];
        if (replay(c, moves)!.over) break;
      }
      expect(replay(c, moves)!.result!.kind).toBe("break");
    }
  });

  it("starting player alternates every round", () => {
    expect([1, 2, 3, 4].map(starterForRound)).toEqual(["host", "guest", "host", "guest"]);
  });
});

describe("Heartfall protocol (host-authoritative)", () => {
  it("host publishes the config; guest joins and uses the exact same config", () => {
    const net = new Net(makeEnv([[1, 6, 10]]));
    expect(net.s.guest.cfg).toBeNull();
    expect(canTap(net.s.host)).toBe(false); // guest not here yet
    net.begin();
    expect(net.s.guest.cfg).toEqual({ gameId: net.s.host.cfg!.gameId, round: 1, fragile: [1, 6, 10], firstPlayer: "host" });
    expect(net.s.host.peerPresent).toBe(true);
    expect(canTap(net.s.host)).toBe(true);
    expect(canTap(net.s.guest)).toBe(false); // host moves first in round 1
    net.expectInSync();
    // the guest never generated anything: its only messages are hellos
    expect(net.sent.filter((m) => m.from === "guest").every((m) => m.msg.hello === true)).toBe(true);
  });

  it("host first move → guest receives; guest move only applies after the host confirms", () => {
    const net = new Net(makeEnv([[9, 10, 11]]));
    net.begin();
    net.tap("host", 0);
    net.flush();
    expect(net.s.guest.board!.used[0]).toBe(true);
    expect(net.s.guest.board!.turn).toBe("guest");

    net.tap("guest", 1);
    expect(net.s.guest.pending).toBe(1);
    expect(net.s.guest.board!.used[1]).toBe(false); // not confirmed yet
    const req = net.queue[0].msg as GameMessage;
    expect(req).toMatchObject({ action: "move", player: "guest", moveId: 1, pieceIndex: 1, crackCount: 0, remainingPieces: 11 });
    net.flush();
    expect(net.s.guest.board!.used[1]).toBe(true);
    expect(net.s.guest.pending).toBeNull();
    const conf = net.sent.filter((m) => m.from === "host" && m.msg.action === "move").at(-1)!.msg;
    expect(conf).toMatchObject({ player: "guest", moveId: 1, pieceIndex: 1, crackCount: 0, remainingPieces: 10 });
    net.expectInSync();
  });

  it("fragile pieces add cracks; third crack ends the match; winner scores", () => {
    const net = new Net(makeEnv([[0, 1, 2]]));
    net.begin();
    net.step(() => 0); // host: crack 1
    expect(net.s.guest.board!.cracks).toBe(1);
    net.step(() => 5); // guest: safe
    net.step(() => 1); // host: crack 2
    net.step(() => 6); // guest: safe
    net.step(() => 2); // host: crack 3 → breaks
    for (const side of ["host", "guest"] as Player[]) {
      expect(net.s[side].board!.result).toEqual({ kind: "break", loser: "host", winner: "guest" });
      expect(scoresOf(net.s[side])).toEqual({ host: 0, guest: 1 });
      expect(canTap(net.s[side])).toBe(false);
    }
    // no further moves accepted
    net.inject("host", { action: "move", gameId: net.s.host.cfg!.gameId, round: 1, moveId: 5, player: "guest", pieceIndex: 7, crackCount: 3, remainingPieces: 7 });
    net.flush();
    expect(net.s.host.moves).toHaveLength(5);
  });

  it("removed pieces, rapid taps and out-of-turn taps do nothing locally", () => {
    const net = new Net(makeEnv([[9, 10, 11]]));
    net.begin();
    net.tap("host", 0);
    net.tap("host", 1); // second tap in the same turn
    net.tap("guest", 2); // guest tapping before the host's move arrived (still host's turn for it)
    expect(net.queue.filter((q) => (q.msg as GameMessage).action === "move")).toHaveLength(1);
    net.flush();
    net.tap("guest", 0); // removed piece
    expect(net.queue).toHaveLength(0);
    net.tap("guest", 3);
    net.tap("guest", 4); // waiting for confirmation → ignored
    expect(net.queue).toHaveLength(1);
    net.flush();
    net.expectInSync();
    expect(net.s.host.moves).toEqual([0, 3]);
  });

  it("host rejects invalid / out-of-turn / stale guest requests and resyncs the guest", () => {
    const net = new Net(makeEnv([[9, 10, 11]]));
    net.begin();
    const gid = net.s.host.cfg!.gameId;
    const before = JSON.stringify(net.s.host.moves);
    const bad: unknown[] = [
      { action: "move", gameId: gid, round: 1, moveId: 0, player: "guest", pieceIndex: 3, crackCount: 0, remainingPieces: 12 }, // out of turn
      { action: "move", gameId: gid, round: 1, moveId: 0, player: "host", pieceIndex: 3, crackCount: 0, remainingPieces: 12 }, // impersonation
      { action: "move", gameId: gid, round: 1, moveId: 0, player: "guest", pieceIndex: 12, crackCount: 0, remainingPieces: 12 },
      { action: "move", gameId: gid, round: 1, moveId: 0, player: "guest", pieceIndex: 1.5, crackCount: 0, remainingPieces: 12 },
      { action: "move", gameId: gid - 1, round: 1, moveId: 0, player: "guest", pieceIndex: 3, crackCount: 0, remainingPieces: 12 },
      { action: "move", gameId: gid, round: 0, moveId: 0, player: "guest", pieceIndex: 3, crackCount: 0, remainingPieces: 12 },
      { action: "move", gameId: gid, round: 1, moveId: 0, player: "guest", pieceIndex: "3", crackCount: 0, remainingPieces: 12 },
      null, "move", [], {}, { action: "explode" },
    ];
    for (const m of bad) net.inject("host", m);
    net.flush();
    expect(JSON.stringify(net.s.host.moves)).toBe(before);
    net.expectInSync();
    // a guest request with a wrong view of the board is rejected too
    net.tap("host", 0);
    net.flush();
    net.inject("host", { action: "move", gameId: gid, round: 1, moveId: 1, player: "guest", pieceIndex: 4, crackCount: 2, remainingPieces: 11 });
    net.flush();
    expect(net.s.host.moves).toEqual([0]);
  });

  it("guest rejects forged host confirmations that don't match the shared config", () => {
    const net = new Net(makeEnv([[0, 1, 2]]));
    net.begin();
    const gid = net.s.host.cfg!.gameId;
    net.inject("guest", { action: "move", gameId: gid, round: 1, moveId: 0, player: "host", pieceIndex: 5, crackCount: 1, remainingPieces: 11 }); // 5 is safe
    net.inject("guest", { action: "move", gameId: gid, round: 1, moveId: 0, player: "guest", pieceIndex: 5, crackCount: 0, remainingPieces: 11 }); // wrong mover
    net.flush();
    expect(net.s.guest.moves).toEqual([]);
    net.expectInSync();
  });

  it("duplicate delivery of every message changes nothing (several full matches)", () => {
    const net = new Net(makeEnv([], 11));
    net.duplicate = true;
    net.begin();
    const r = rng(4);
    for (let round = 1; round <= 4; round++) {
      net.playOut((o) => o[Math.floor(r() * o.length)]);
      net.rematch("guest");
      net.rematch("host");
      net.flush();
      net.expectInSync();
      expect(net.s.host.cfg!.round).toBe(round + 1);
    }
  });

  it("rematch: needs both players, alternates the first player, keeps scores, new fragile set", () => {
    const net = new Net(makeEnv([[0, 1, 2], [3, 4, 5], [6, 7, 8]]));
    net.begin();
    net.playOut(); // host takes 0 (crack), guest 3, host 1, guest 4, host 2 → host breaks
    expect(scoresOf(net.s.guest)).toEqual({ host: 0, guest: 1 });

    net.rematch("host");
    net.flush();
    expect(net.s.host.cfg!.round).toBe(1); // waiting for the guest
    expect(net.s.guest.peerRematch).toBe(true);
    net.rematch("host"); // duplicate tap
    net.flush();
    expect(net.sent.filter((m) => m.msg.action === "rematch")).toHaveLength(1);

    net.rematch("guest");
    net.flush();
    net.expectInSync();
    expect(net.s.guest.cfg).toMatchObject({ round: 2, fragile: [3, 4, 5], firstPlayer: "guest" });
    expect(net.s.guest.board!.cracks).toBe(0);
    expect(net.s.guest.board!.remaining).toBe(12);
    expect(scoresOf(net.s.host)).toEqual({ host: 0, guest: 1 }); // preserved
    expect(canTap(net.s.guest)).toBe(true);
    expect(canTap(net.s.host)).toBe(false);

    net.playOut();
    net.rematch("guest");
    net.rematch("host"); // simultaneous
    net.flush();
    net.expectInSync();
    expect(net.s.host.cfg).toMatchObject({ round: 3, firstPlayer: "host" });
    expect(net.sent.filter((m) => m.msg.action === "start" && m.msg.round === 3)).toHaveLength(1); // one new round only
  });

  it("old messages arriving after a rematch are ignored", () => {
    const net = new Net(makeEnv([], 21));
    net.begin();
    net.playOut();
    const old = net.sent.slice();
    net.rematch("host");
    net.rematch("guest");
    net.flush();
    const before = JSON.stringify(net.s);
    for (const { from, msg } of old) net.inject(otherSide(from), msg);
    net.flush();
    // At most the guest got re-sent the current snapshot; the game itself is unchanged.
    net.expectInSync();
    expect(net.s.host.cfg!.round).toBe(2);
    expect(net.s.host.moves).toEqual(JSON.parse(before).host.moves);
    expect(scoresOf(net.s.host)).toEqual(scoresOf(JSON.parse(before).host));
  });

  it("a player leaving mid-game stops the match; returning starts a fresh session with scores reset", () => {
    const net = new Net(makeEnv([[0, 1, 2], [9, 10, 11]]));
    net.begin();
    net.playOut(); // guest wins round 1 → 0-1
    net.rematch("host");
    net.rematch("guest");
    net.flush();
    net.step((o) => o[0]);
    net.leave("guest");
    net.flush();
    expect(net.s.host.peerLeft).toBe(true);
    expect(canTap(net.s.host)).toBe(false);
    const frozen = JSON.stringify(net.s.host);
    net.tap("host", 11);
    net.rematch("host");
    net.inject("host", { action: "move", gameId: net.s.host.cfg!.gameId, round: 2, moveId: 1, player: "guest", pieceIndex: 4, crackCount: 0, remainingPieces: 11 });
    net.flush();
    expect(JSON.stringify(net.s.host)).toBe(frozen);

    // guest opens the game again
    net.s.guest = createState("guest");
    net.mount("guest");
    net.flush();
    net.expectInSync();
    expect(net.s.host.peerLeft).toBe(false);
    expect(net.s.host.cfg!.round).toBe(1);
    expect(scoresOf(net.s.host)).toEqual({ host: 0, guest: 0 });
  });

  it("host leaving: guest is notified; the host's re-opened game replaces the old one", () => {
    const net = new Net(makeEnv([[0, 1, 2]]));
    net.begin();
    net.step((o) => o[3]);
    net.leave("host");
    net.flush();
    expect(net.s.guest.peerLeft).toBe(true);
    net.tap("guest", 5);
    expect(net.queue).toHaveLength(0);
    // stale snapshot of the old game must not revive it
    const oldGame = net.s.host;
    net.s.host = createState("host", net.env); // new mount → newer gameId
    net.mount("host");
    net.flush();
    expect(net.s.guest.peerLeft).toBe(false);
    expect(net.s.guest.cfg!.gameId).toBe(net.s.host.cfg!.gameId);
    net.inject("guest", { ...JSON.parse(JSON.stringify(mountMessage(oldGame))) });
    net.flush();
    net.expectInSync();
  });

  it("guest recovers when a confirmation is lost (timeout → resync)", () => {
    const net = new Net(makeEnv([[9, 10, 11]]));
    net.begin();
    net.tap("host", 0);
    net.flush();
    net.tap("guest", 1);
    net.flush(); // host confirmed…
    // simulate: guest never saw it
    net.s.guest = { ...net.s.guest, moves: [0], board: replay(net.s.guest.cfg!, [0]), pending: 1 };
    const step = guestResync(net.s.guest);
    net.s.guest = step.state;
    for (const m of step.out) net.inject("host", JSON.parse(JSON.stringify(m)));
    net.flush();
    net.expectInSync();
    expect(net.s.guest.moves).toEqual([0, 1]);
    expect(net.s.guest.pending).toBeNull();
  });

  it("many full matches with random play stay in sync; all messages < 512 B and declared", () => {
    for (let seed = 1; seed <= 15; seed++) {
      const net = new Net(makeEnv([], seed));
      net.begin();
      const r = rng(seed * 7);
      for (let round = 1; round <= 3; round++) {
        net.playOut((o) => o[Math.floor(r() * o.length)]);
        expect(net.s.host.board!.result!.kind).toBe("break");
        net.rematch(round % 2 ? "host" : "guest");
        net.rematch(round % 2 ? "guest" : "host");
        net.flush();
      }
      net.expectInSync();
      const total = scoresOf(net.s.host);
      expect(total.host + total.guest).toBe(3);
      net.leave("host");
      net.flush();
      expect(new Set(net.sent.map((m) => m.msg.action))).toEqual(new Set(meta.actions));
    }
  });
});
