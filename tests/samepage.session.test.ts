import { describe, expect, it } from "vitest";
import type { GameMessage } from "../src/games/samepage";
import { meta } from "../src/games/samepage/meta";
import { QUESTIONS } from "../src/games/samepage/questions";
import {
  ANSWER_MAX_BYTES,
  QUESTION_MAX_BYTES,
  TOTAL_ROUNDS,
  askerFor,
  createState,
  helloMessage,
  localAnswer,
  localLeave,
  localNext,
  localQuestion,
  localRematch,
  localStart,
  messageBytes,
  parse,
  receive,
  type Player,
  type State,
  type Step,
} from "../src/games/samepage/session";

const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const otherSide = (p: Player): Player => (p === "host" ? "guest" : "host");

/** In-memory bridge. JSON round-trips every message; can duplicate and/or shuffle delivery. */
class Net {
  s: Record<Player, State>;
  queue: { to: Player; msg: unknown }[] = [];
  sent: { from: Player; msg: GameMessage }[] = [];
  duplicate = false;
  shuffle: (() => number) | null = null;

  constructor() {
    this.s = { host: createState("host", 1001), guest: createState("guest", 2002) };
  }
  private apply(side: Player, step: Step) {
    this.s[side] = step.state;
    for (const m of step.out) {
      expect(messageBytes(m)).toBeLessThan(512);
      this.sent.push({ from: side, msg: m });
      const to = otherSide(side);
      this.queue.push({ to, msg: JSON.parse(JSON.stringify(m)) });
      if (this.duplicate) this.queue.push({ to, msg: JSON.parse(JSON.stringify(m)) });
    }
  }
  do(side: Player, fn: (s: State) => Step) {
    this.apply(side, fn(this.s[side]));
  }
  hello(side: Player) {
    this.apply(side, { state: this.s[side], out: [helloMessage(this.s[side])] });
  }
  inject(to: Player, msg: unknown) {
    this.queue.push({ to, msg });
  }
  flush() {
    let guard = 0;
    while (this.queue.length) {
      if (++guard > 10_000) throw new Error("message storm");
      const i = this.shuffle ? Math.floor(this.shuffle() * this.queue.length) : 0;
      const [{ to, msg }] = this.queue.splice(i, 1);
      this.apply(to, receive(this.s[to], msg));
    }
  }
  /** Shared (non-private) parts of the state must match on both devices. */
  expectInSync() {
    const { host: h, guest: g } = this.s;
    expect([g.session, g.round, g.phase, g.firstAsker]).toEqual([h.session, h.round, h.phase, h.firstAsker]);
    expect(g.question).toEqual(h.question);
    if (h.phase === "reveal") {
      expect(h.myAnswer).toBe(g.peerAnswer);
      expect(g.myAnswer).toBe(h.peerAnswer);
    }
  }
  begin() {
    this.hello("host");
    this.hello("guest");
    this.flush();
    this.do("host", localStart);
    this.flush();
  }
  /** Plays the current round: asker asks, both answer (order configurable), reveal, next. */
  playRound(opts: { firstToAnswer?: Player; simultaneous?: boolean; nextBy?: Player } = {}) {
    const round = this.s.host.round;
    const asker = askerFor(this.s.host, round);
    const st = this.s[asker];
    if (round > 10) {
      this.do(asker, (s) => localQuestion(s, { text: `Custom ${asker} q${round}?`, qid: -1, category: "custom" }));
    } else {
      const q = QUESTIONS.find((x) => !st.usedQids.includes(x.qid))!;
      this.do(asker, (s) => localQuestion(s, { text: q.text, qid: q.qid, category: q.category }));
    }
    this.flush();
    const first = opts.firstToAnswer ?? asker;
    const second = otherSide(first);
    this.do(first, (s) => localAnswer(s, `${first} says ${round}`));
    if (!opts.simultaneous) this.flush();
    this.do(second, (s) => localAnswer(s, `${second} says ${round}`));
    this.flush();
    expect(this.s.host.phase).toBe("reveal");
    this.expectInSync();
    this.do(opts.nextBy ?? second, localNext);
    this.flush();
    this.expectInSync();
    return asker;
  }
  playGame(opts: Parameters<Net["playRound"]>[0] = {}) {
    const askers: Player[] = [];
    while (this.s.host.phase !== "done") askers.push(this.playRound(opts));
    return askers;
  }
}

describe("Same Page protocol", () => {
  it("handshake; only the host can start; host asks round 1", () => {
    const net = new Net();
    net.hello("host");
    net.hello("guest");
    net.flush();
    expect(net.s.host.peerPresent && net.s.guest.peerPresent).toBe(true);
    expect(net.sent.filter((m) => m.msg.action === "start")).toHaveLength(4);

    net.inject("host", { action: "start", session: 1, round: 1, nonce: 5 }); // guest can't start the game
    net.flush();
    expect(net.s.host.phase).toBe("lobby");

    net.do("host", localStart);
    net.flush();
    net.expectInSync();
    expect(net.s.guest.phase).toBe("asking");
    expect(net.s.guest.round).toBe(1);
    expect(askerFor(net.s.guest, 1)).toBe("host");
  });

  it("host can't start before the guest is present", () => {
    const net = new Net();
    net.do("host", localStart);
    expect(net.sent).toHaveLength(0);
    expect(net.s.host.phase).toBe("lobby");
  });

  it("full game: 10 bank rounds + host custom + guest custom, askers alternate, no repeats, done", () => {
    const net = new Net();
    net.begin();
    const askers = net.playGame();
    expect(askers).toEqual(["host", "guest", "host", "guest", "host", "guest", "host", "guest", "host", "guest", "host", "guest"]);
    expect(net.s.host.phase).toBe("done");
    expect(net.s.guest.phase).toBe("done");
    const qs = net.sent.filter((m) => m.msg.action === "question").map((m) => m.msg);
    expect(qs).toHaveLength(TOTAL_ROUNDS);
    const bankIds = qs.slice(0, 10).map((q) => q.qid);
    expect(new Set(bankIds).size).toBe(10);
    expect(qs.slice(10).map((q) => [q.asker, q.qid, q.category])).toEqual([
      ["host", -1, "custom"],
      ["guest", -1, "custom"],
    ]);
  });

  it("answers stay private until both submit; the receiver of the 2nd answer coordinates the reveal", () => {
    const net = new Net();
    net.begin();
    const q = QUESTIONS[0];
    net.do("host", (s) => localQuestion(s, { text: q.text, qid: q.qid, category: q.category }));
    net.flush();
    expect(net.s.guest.phase).toBe("answering");

    net.do("host", (s) => localAnswer(s, "Japan"));
    net.flush();
    // Guest holds the answer privately but is not in the reveal phase.
    expect(net.s.guest.phase).toBe("answering");
    expect(net.s.guest.myAnswer).toBeNull();

    net.do("guest", (s) => localAnswer(s, "Switzerland"));
    // Guest answered second: it must NOT reveal on its own…
    expect(net.s.guest.phase).toBe("answering");
    const q1 = net.queue.length;
    expect(q1).toBe(1); // only its answer is in flight
    net.flush();
    // …the host received the 2nd answer, revealed and sent "reveal".
    const reveal = net.sent.find((m) => m.msg.action === "reveal")!;
    expect(reveal.from).toBe("host");
    expect(reveal.msg).toMatchObject({ hostAnswer: "Japan", guestAnswer: "Switzerland", round: 1, session: 1 });
    expect(net.s.host.phase).toBe("reveal");
    expect(net.s.guest.phase).toBe("reveal");
    net.expectInSync();
  });

  it("simultaneous submissions reveal on both sides; the second reveal is ignored", () => {
    const net = new Net();
    net.begin();
    net.playRound({ simultaneous: true });
    expect(net.sent.filter((m) => m.msg.action === "reveal")).toHaveLength(2);
    net.expectInSync();
    expect(net.s.host.round).toBe(2);
  });

  it("ignores duplicate answers and prevents resubmission", () => {
    const net = new Net();
    net.begin();
    const q = QUESTIONS[3];
    net.do("host", (s) => localQuestion(s, { text: q.text, qid: q.qid, category: q.category }));
    net.flush();
    net.do("guest", (s) => localAnswer(s, "first"));
    net.do("guest", (s) => localAnswer(s, "second try")); // locked → ignored
    expect(net.sent.filter((m) => m.msg.action === "answer")).toHaveLength(1);
    net.flush();
    net.inject("host", { action: "answer", session: 1, round: 1, answer: "forged replacement", player: "guest" });
    net.flush();
    expect(net.s.host.peerAnswer).toBe("first");
    net.do("host", (s) => localAnswer(s, "mine"));
    net.flush();
    expect(net.s.host.phase).toBe("reveal");
    expect(net.s.guest.peerAnswer).toBe("mine");
    expect(net.s.host.peerAnswer).toBe("first");
  });

  it("everything still works when every message is delivered twice", () => {
    const net = new Net();
    net.duplicate = true;
    net.begin();
    net.playGame();
    expect(net.s.guest.phase).toBe("done");
    net.do("host", localRematch);
    net.do("guest", localRematch);
    net.flush();
    net.expectInSync();
    expect(net.s.host.session).toBe(2); // not 3
  });

  it("rejects a tampered reveal", () => {
    const net = new Net();
    net.begin();
    const q = QUESTIONS[5];
    net.do("host", (s) => localQuestion(s, { text: q.text, qid: q.qid, category: q.category }));
    net.flush();
    net.do("host", (s) => localAnswer(s, "A"));
    net.flush();
    net.do("guest", (s) => localAnswer(s, "B"));
    net.queue = []; // guest's real answer is in flight but we'll check guest's view of a fake reveal
    net.inject("guest", { action: "reveal", session: 1, round: 1, hostAnswer: "A", guestAnswer: "NOT B" });
    net.inject("guest", { action: "reveal", session: 1, round: 1, hostAnswer: "X", guestAnswer: "B" });
    net.flush();
    expect(net.s.guest.phase).toBe("answering");
    net.inject("guest", { action: "reveal", session: 1, round: 1, hostAnswer: "A", guestAnswer: "B" });
    net.flush();
    expect(net.s.guest.phase).toBe("reveal");
  });

  it("rejects questions from the wrong player and forged bank questions", () => {
    const net = new Net();
    net.begin(); // round 1: host asks
    const q = QUESTIONS[0];
    net.inject("host", { action: "question", session: 1, round: 1, question: q.text, asker: "guest", qid: 0, category: q.category });
    net.flush();
    expect(net.s.host.phase).toBe("asking");
    net.inject("guest", { action: "question", session: 1, round: 1, question: "Something not in the bank?", asker: "host", qid: 0, category: q.category });
    net.inject("guest", { action: "question", session: 1, round: 1, question: "Free text in a bank round", asker: "host", qid: -1, category: "custom" });
    net.flush();
    expect(net.s.guest.phase).toBe("asking");
    // Guest can't ask in round 1.
    net.do("guest", (s) => localQuestion(s, { text: q.text, qid: 0, category: q.category }));
    expect(net.queue).toHaveLength(0);
  });

  it("an answer that arrives before its question is held back, then applied (out of order)", () => {
    const net = new Net();
    net.begin();
    const q = QUESTIONS[7];
    net.do("host", (s) => localQuestion(s, { text: q.text, qid: q.qid, category: q.category }));
    net.do("host", (s) => localAnswer(s, "early"));
    expect(net.queue.map((x) => (x.msg as GameMessage).action)).toEqual(["question", "answer"]);
    net.queue.reverse(); // answer overtakes the question
    net.flush();
    expect(net.s.guest.phase).toBe("answering");
    expect(net.s.guest.peerAnswer).toBe("early");
    expect(net.s.guest.pending).toHaveLength(0);
  });

  it("'next' cannot start a round before the reveal; an early 'next' waits", () => {
    const net = new Net();
    net.begin();
    net.inject("guest", { action: "next", session: 1, round: 2, asker: "guest" });
    net.flush();
    expect(net.s.guest.round).toBe(1);
    expect(net.s.guest.phase).toBe("asking");
    net.do("guest", localNext); // can't skip locally either
    expect(net.s.guest.round).toBe(1);
    // Once the round is revealed, the held-back "next" applies.
    const q = QUESTIONS[1];
    net.do("host", (s) => localQuestion(s, { text: q.text, qid: q.qid, category: q.category }));
    net.flush();
    net.do("host", (s) => localAnswer(s, "h"));
    net.flush();
    net.do("guest", (s) => localAnswer(s, "g"));
    net.flush();
    // the injected early "next" was applied right after the reveal on the guest
    expect(net.s.guest.round).toBe(2);
  });

  it("full games stay in sync with random out-of-order delivery (many seeds)", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const net = new Net();
      net.shuffle = rng(seed);
      net.duplicate = seed % 3 === 0;
      net.begin();
      net.playGame({ firstToAnswer: seed % 2 ? "host" : "guest", nextBy: seed % 4 < 2 ? "host" : "guest" });
      expect(net.s.host.phase).toBe("done");
      net.expectInSync();
      net.do("guest", localRematch);
      net.do("host", localRematch);
      net.flush();
      net.expectInSync();
      expect(net.s.host.session).toBe(2);
      expect(net.s.guest.firstAsker).toBe("guest");
    }
  });

  it("rematch needs both players and the first asker alternates every game", () => {
    const net = new Net();
    net.begin();
    const firsts: Player[] = [];
    for (let game = 1; game <= 3; game++) {
      firsts.push(askerFor(net.s.host, 1));
      expect(net.s.host.session).toBe(game);
      net.playGame();
      net.do("host", localRematch);
      net.flush();
      expect(net.s.host.session).toBe(game); // waiting for the guest
      expect(net.s.guest.peerRematch).toBe(true);
      net.do("guest", localRematch);
      net.flush();
      net.expectInSync();
      expect(net.s.host.phase).toBe("asking");
      expect(net.s.host.round).toBe(1);
      expect(net.s.host.myAnswer).toBeNull();
    }
    expect(firsts).toEqual(["host", "guest", "host"]);
    expect(askerFor(net.s.host, 1)).toBe("guest"); // 4th game
  });

  it("stale messages from a previous session cannot affect the rematch", () => {
    const net = new Net();
    net.begin();
    net.playGame();
    const old = net.sent.filter((m) => m.msg.session === 1);
    net.do("host", localRematch);
    net.do("guest", localRematch);
    net.flush();
    const before = JSON.stringify(net.s);
    // Every old message arrives again, very late, at its real recipient.
    for (const { from, msg } of old) net.inject(otherSide(from), msg);
    // …and echoed back to its sender.
    for (const { from, msg } of old) net.inject(from, msg);
    net.flush();
    expect(JSON.stringify(net.s)).toBe(before);
    net.inject("guest", { action: "leave", session: 1 });
    net.flush();
    expect(net.s.guest.peerLeft).toBe(false);
  });

  it("a player leaving at any stage stops the game for the other", () => {
    for (const stage of ["lobby", "asking", "answering", "reveal", "done"] as const) {
      const net = new Net();
      net.hello("host");
      net.hello("guest");
      net.flush();
      if (stage !== "lobby") {
        net.do("host", localStart);
        net.flush();
      }
      if (stage === "answering" || stage === "reveal") {
        const q = QUESTIONS[2];
        net.do("host", (s) => localQuestion(s, { text: q.text, qid: q.qid, category: q.category }));
        net.flush();
        net.do("host", (s) => localAnswer(s, "x"));
        net.flush();
        if (stage === "reveal") {
          net.do("guest", (s) => localAnswer(s, "y"));
          net.flush();
        }
      }
      if (stage === "done") net.playGame();
      expect(net.s.host.phase).toBe(stage);
      net.do("guest", localLeave);
      net.flush();
      expect(net.s.host.peerLeft).toBe(true);
      const snapshot = JSON.stringify(net.s.host);
      // Nothing can move the game forward any more.
      net.do("host", localStart);
      net.do("host", localNext);
      net.do("host", localRematch);
      net.do("host", (s) => localAnswer(s, "late"));
      net.inject("host", { action: "answer", session: 1, round: 1, answer: "late", player: "guest" });
      net.flush();
      expect(JSON.stringify(net.s.host)).toBe(snapshot);
    }
  });

  it("after a leave, re-opening the game brings both back to the lobby", () => {
    const net = new Net();
    net.begin();
    net.playRound();
    net.do("guest", localLeave);
    net.flush();
    net.s.guest = createState("guest", 3003); // fresh copy
    net.hello("guest");
    net.flush();
    expect(net.s.host.peerLeft).toBe(false);
    expect(net.s.host.phase).toBe("lobby");
    net.do("host", localStart);
    net.flush();
    net.expectInSync();
    expect(net.s.guest.phase).toBe("asking");
  });

  it("validates empty / oversized questions and answers", () => {
    const net = new Net();
    net.begin();
    // play to the custom rounds
    for (let i = 0; i < 10; i++) net.playRound();
    expect(net.s.host.round).toBe(11);
    const n = net.sent.length;
    net.do("host", (s) => localQuestion(s, { text: "   \n  ", qid: -1, category: "custom" }));
    net.do("host", (s) => localQuestion(s, { text: "x".repeat(QUESTION_MAX_BYTES), qid: -1, category: "custom" }));
    expect(net.sent.length).toBe(n);
    net.do("host", (s) => localQuestion(s, { text: "  What's your favourite smell?  ", qid: -1, category: "custom" }));
    net.flush();
    expect(net.s.guest.question?.text).toBe("What's your favourite smell?");
    net.do("guest", (s) => localAnswer(s, ""));
    net.do("guest", (s) => localAnswer(s, " \n\t "));
    net.do("guest", (s) => localAnswer(s, "é".repeat(ANSWER_MAX_BYTES)));
    expect(net.s.guest.myAnswer).toBeNull();
    expect(parse({ action: "answer", session: 1, round: 11, answer: "", player: "guest" })).toBeNull();
    expect(parse({ action: "question", session: 1, round: 11, question: " ", asker: "host", qid: -1, category: "custom" })).toBeNull();
  });

  it("rejects malformed and unknown messages without changing state", () => {
    const net = new Net();
    net.begin();
    const before = JSON.stringify(net.s.guest);
    const bad: unknown[] = [
      null, undefined, 1, "x", [], {},
      { action: "boom", session: 1 },
      { action: "answer" },
      { action: "answer", session: 0, round: 1, answer: "a", player: "host" },
      { action: "answer", session: 1, round: 99, answer: "a", player: "host" },
      { action: "answer", session: 1, round: 1, answer: 5, player: "host" },
      { action: "answer", session: 1, round: 1, answer: "a", player: "admin" },
      { action: "answer", session: "1", round: 1, answer: "a", player: "host" },
      { action: "question", session: 1, round: 1, question: "Q?", asker: "host", qid: 9999, category: "know" },
      { action: "question", session: 1, round: 1, question: QUESTIONS[0].text, asker: "host", qid: 0, category: "nope" },
      { action: "reveal", session: 1, round: 1, hostAnswer: "a" },
      { action: "next", session: 1, round: 2, asker: "nobody" },
      { action: "next", session: 1, round: 14, asker: null },
      { action: "rematch", session: 1, firstAsker: "guest" },
      { action: "start", session: 1, round: 5 },
      { action: "start", session: 1, round: 0, started: "no", reply: false, nonce: 1 },
      { action: "answer", session: 1, round: 1, answer: "x".repeat(600), player: "host" },
    ];
    for (const m of bad) net.inject("guest", m);
    net.flush();
    expect(JSON.stringify(net.s.guest)).toBe(before);
  });

  it("every message is < 512 bytes in the worst case and uses only meta.actions", () => {
    const net = new Net();
    net.begin();
    for (let i = 0; i < 10; i++) net.playRound();
    // worst-case custom question and answers (JSON escaping + multibyte)
    const bigQ = ("\"é🙂" + "q".repeat(400)).slice(0, 400);
    let qText = "";
    for (const ch of bigQ) {
      const t = qText + ch;
      if (new TextEncoder().encode(JSON.stringify(t)).length > QUESTION_MAX_BYTES) break;
      qText = t;
    }
    net.do("host", (s) => localQuestion(s, { text: qText, qid: -1, category: "custom" }));
    net.flush();
    let aText = "";
    for (const ch of "\"🙂é\\".repeat(200)) {
      const t = aText + ch;
      if (new TextEncoder().encode(JSON.stringify(t)).length > ANSWER_MAX_BYTES) break;
      aText = t;
    }
    net.do("host", (s) => localAnswer(s, aText));
    net.do("guest", (s) => localAnswer(s, aText));
    net.flush();
    expect(net.s.host.phase).toBe("reveal");
    net.do("guest", localNext);
    net.flush();
    net.playRound();
    net.do("host", localRematch);
    net.do("guest", localRematch);
    net.flush();
    net.do("host", localLeave);
    net.flush();
    const sizes = net.sent.map((m) => messageBytes(m.msg));
    expect(Math.max(...sizes)).toBeLessThan(512);
    expect(Math.max(...sizes)).toBeGreaterThan(400); // the worst-case reveal was really measured
    for (const { msg } of net.sent) expect(meta.actions).toContain(msg.action);
    expect(new Set(net.sent.map((m) => m.msg.action))).toEqual(new Set(meta.actions));
  });

  it("question bank: 6 categories, ≥10 each, unique texts", () => {
    const byCat = new Map<string, number>();
    for (const q of QUESTIONS) byCat.set(q.category, (byCat.get(q.category) ?? 0) + 1);
    expect(byCat.size).toBe(6);
    for (const n of byCat.values()) expect(n).toBeGreaterThanOrEqual(10);
    expect(new Set(QUESTIONS.map((q) => q.text)).size).toBe(QUESTIONS.length);
  });
});
