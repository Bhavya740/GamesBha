/**
 * Same Page – pure game state machine + multiplayer protocol.
 *
 * Every function takes the current state plus an event and returns the next
 * state and the messages to send. No React, no I/O. The component only wires
 * these functions to Gulaab's `send` / `onMessage`.
 *
 * Flow per round:  asking → answering → reveal → (next) asking …
 * Session flow:    lobby → rounds 1–10 (bank questions) → rounds 11–12 (custom) → done
 */
import type { GameMessage } from "./index";
import { CATEGORIES, CUSTOM_CATEGORY, QUESTIONS } from "./questions";

export type Player = "host" | "guest";
export type Phase = "lobby" | "asking" | "answering" | "reveal" | "done";

export const REGULAR_ROUNDS = 10;
export const CUSTOM_ROUNDS = 2;
export const TOTAL_ROUNDS = REGULAR_ROUNDS + CUSTOM_ROUNDS;

export const MAX_MESSAGE_BYTES = 512;
/** Limits are on the JSON-encoded UTF-8 size so every message stays < 512 B. */
export const ANSWER_MAX_BYTES = 180;
export const QUESTION_MAX_BYTES = 220;

const MAX_SESSION = 1_000_000;
const MAX_NONCE = 2 ** 31 - 1;
const MAX_PENDING = 16;

export interface Question {
  text: string;
  /** Index in the question bank, or -1 for a custom question. */
  qid: number;
  category: string;
}

export interface State {
  readonly role: Player;
  /** Random id of this mounted copy (only used to recognise a re-opened peer). */
  readonly nonce: number;
  readonly peerNonce: number | null;
  readonly session: number;
  readonly firstAsker: Player;
  readonly round: number;
  readonly phase: Phase;
  readonly peerPresent: boolean;
  readonly peerLeft: boolean;
  readonly question: Question | null;
  readonly myAnswer: string | null;
  /**
   * The other player's answer. Kept privately in memory and NEVER rendered
   * until phase === "reveal".
   */
  readonly peerAnswer: string | null;
  readonly myRematch: boolean;
  readonly peerRematch: boolean;
  /** Bank questions already asked (kept across rematches to avoid repeats). */
  readonly usedQids: readonly number[];
  /** Valid messages that arrived early (out of order); retried after each change. */
  readonly pending: readonly Msg[];
}

export interface Step {
  state: State;
  out: GameMessage[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const other = (p: Player): Player => (p === "host" ? "guest" : "host");

/** Odd rounds are asked by the session's first asker, even rounds by the other player. */
export function askerFor(s: Pick<State, "firstAsker">, round: number): Player {
  return round % 2 === 1 ? s.firstAsker : other(s.firstAsker);
}

export const isCustomRound = (round: number) => round > REGULAR_ROUNDS;

/** Normalises user text identically on both devices. */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const encoder = new TextEncoder();
/** UTF-8 size of a string once JSON-encoded (quotes and escapes included). */
export const jsonBytes = (s: string) => encoder.encode(JSON.stringify(s)).length;
export const messageBytes = (m: GameMessage) => encoder.encode(JSON.stringify(m)).length;

function validText(v: unknown, maxBytes: number): v is string {
  return typeof v === "string" && v.length > 0 && v === cleanText(v) && jsonBytes(v) <= maxBytes;
}
export const isValidAnswer = (v: unknown): v is string => validText(v, ANSWER_MAX_BYTES);
export const isValidCustomQuestion = (v: unknown): v is string => validText(v, QUESTION_MAX_BYTES);

function isValidQuestionFor(round: number, q: Question): boolean {
  if (isCustomRound(round)) {
    return q.qid === -1 && q.category === CUSTOM_CATEGORY && isValidCustomQuestion(q.text);
  }
  const b = QUESTIONS[q.qid];
  return !!b && b.text === q.text && b.category === q.category;
}

const noop = (state: State): Step => ({ state, out: [] });

export function createState(role: Player, nonce: number): State {
  return {
    role,
    nonce,
    peerNonce: null,
    session: 1,
    firstAsker: "host",
    round: 0,
    phase: "lobby",
    peerPresent: false,
    peerLeft: false,
    question: null,
    myAnswer: null,
    peerAnswer: null,
    myRematch: false,
    peerRematch: false,
    usedQids: [],
    pending: [],
  };
}

function roundReset(s: State, round: number): State {
  return {
    ...s,
    round,
    phase: round > TOTAL_ROUNDS ? "done" : "asking",
    question: null,
    myAnswer: null,
    peerAnswer: null,
    myRematch: false,
    peerRematch: false,
  };
}

function newSession(s: State): State {
  return roundReset({ ...s, session: s.session + 1, firstAsker: other(s.firstAsker), pending: [] }, 1);
}

// ---------------------------------------------------------------------------
// Outgoing messages
// ---------------------------------------------------------------------------

/** Presence handshake, sent once on mount (`reply: false`) and answered once (`reply: true`). */
export function helloMessage(s: State, reply = false): GameMessage {
  return { action: "start", session: s.session, round: 0, started: s.phase !== "lobby", reply, nonce: s.nonce };
}

// ---------------------------------------------------------------------------
// Local actions
// ---------------------------------------------------------------------------

export const canStart = (s: State) => s.role === "host" && s.phase === "lobby" && s.peerPresent && !s.peerLeft;

export function localStart(s: State): Step {
  if (!canStart(s)) return noop(s);
  const next = roundReset({ ...s, firstAsker: "host" }, 1);
  return drain(next, [{ action: "start", session: s.session, round: 1, nonce: s.nonce }]);
}

export const isMyTurnToAsk = (s: State) => s.phase === "asking" && !s.peerLeft && askerFor(s, s.round) === s.role;

export function localQuestion(s: State, q: Question): Step {
  if (!isMyTurnToAsk(s)) return noop(s);
  const question: Question = isCustomRound(s.round)
    ? { text: cleanText(q.text), qid: -1, category: CUSTOM_CATEGORY }
    : q;
  if (!isValidQuestionFor(s.round, question)) return noop(s);
  const next: State = {
    ...s,
    phase: "answering",
    question,
    usedQids: question.qid >= 0 ? [...s.usedQids, question.qid] : s.usedQids,
  };
  return drain(next, [
    {
      action: "question",
      session: s.session,
      round: s.round,
      question: question.text,
      asker: s.role,
      qid: question.qid,
      category: question.category,
    },
  ]);
}

export const canAnswer = (s: State) => s.phase === "answering" && !s.peerLeft && s.myAnswer === null;

export function localAnswer(s: State, text: string): Step {
  if (!canAnswer(s)) return noop(s);
  const answer = cleanText(text);
  if (!isValidAnswer(answer)) return noop(s);
  // If the peer already answered, the peer will receive our answer second and
  // coordinates the reveal; we wait for its validated "reveal" message.
  return drain({ ...s, myAnswer: answer }, [
    { action: "answer", session: s.session, round: s.round, answer, player: s.role },
  ]);
}

export function localNext(s: State): Step {
  if (s.phase !== "reveal" || s.peerLeft) return noop(s);
  const round = s.round + 1;
  const asker = round > TOTAL_ROUNDS ? null : askerFor(s, round);
  return drain(roundReset(s, round), [{ action: "next", session: s.session, round, asker }]);
}

export function localRematch(s: State): Step {
  if (s.phase !== "done" || s.peerLeft || s.myRematch) return noop(s);
  const out: GameMessage[] = [{ action: "rematch", session: s.session + 1, firstAsker: other(s.firstAsker) }];
  const next = { ...s, myRematch: true };
  return next.peerRematch ? drain(newSession(next), out) : { state: next, out };
}

export function localLeave(s: State): Step {
  return { state: s, out: [{ action: "leave", session: s.session }] };
}

// ---------------------------------------------------------------------------
// Incoming messages: parse → validate → apply / ignore / defer
// ---------------------------------------------------------------------------

export type Msg =
  | { t: "hello"; session: number; started: boolean; reply: boolean; nonce: number }
  | { t: "start"; session: number; nonce: number }
  | { t: "question"; session: number; round: number; asker: Player; question: Question }
  | { t: "answer"; session: number; round: number; player: Player; answer: string }
  | { t: "reveal"; session: number; round: number; hostAnswer: string; guestAnswer: string }
  | { t: "next"; session: number; round: number; asker: Player | null }
  | { t: "leave"; session: number }
  | { t: "rematch"; session: number; firstAsker: Player };

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isPlayer = (v: unknown): v is Player => v === "host" || v === "guest";
const CATEGORY_IDS = new Set([...CATEGORIES.map((c) => c.id), CUSTOM_CATEGORY]);

export function parse(raw: unknown): Msg | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const { session, round } = m;
  if (!isInt(session, 1, MAX_SESSION)) return null;

  switch (m.action) {
    case "start":
      if (round === 0) {
        if (typeof m.started !== "boolean" || typeof m.reply !== "boolean" || !isInt(m.nonce, 0, MAX_NONCE)) return null;
        return { t: "hello", session, started: m.started, reply: m.reply, nonce: m.nonce };
      }
      if (round === 1 && isInt(m.nonce, 0, MAX_NONCE)) return { t: "start", session, nonce: m.nonce };
      return null;
    case "question": {
      const { question, asker, qid, category } = m;
      if (!isInt(round, 1, TOTAL_ROUNDS) || !isPlayer(asker) || !isInt(qid, -1, QUESTIONS.length - 1)) return null;
      if (typeof category !== "string" || !CATEGORY_IDS.has(category)) return null;
      if (typeof question !== "string") return null;
      const q: Question = { text: question, qid, category };
      if (!isValidQuestionFor(round, q)) return null;
      return { t: "question", session, round, asker, question: q };
    }
    case "answer":
      if (!isInt(round, 1, TOTAL_ROUNDS) || !isPlayer(m.player) || !isValidAnswer(m.answer)) return null;
      return { t: "answer", session, round, player: m.player, answer: m.answer };
    case "reveal":
      if (!isInt(round, 1, TOTAL_ROUNDS) || !isValidAnswer(m.hostAnswer) || !isValidAnswer(m.guestAnswer)) return null;
      return { t: "reveal", session, round, hostAnswer: m.hostAnswer, guestAnswer: m.guestAnswer };
    case "next": {
      if (!isInt(round, 2, TOTAL_ROUNDS + 1)) return null;
      const asker = m.asker;
      if (round > TOTAL_ROUNDS ? asker !== null : !isPlayer(asker)) return null;
      return { t: "next", session, round, asker: asker as Player | null };
    }
    case "leave":
      return { t: "leave", session };
    case "rematch":
      if (session < 2 || !isPlayer(m.firstAsker)) return null;
      return { t: "rematch", session, firstAsker: m.firstAsker };
    default:
      return null;
  }
}

type Result = { k: "apply"; state: State; out: GameMessage[] } | { k: "ignore" } | { k: "defer" };
const IGNORE: Result = { k: "ignore" };
const DEFER: Result = { k: "defer" };
const apply = (state: State, out: GameMessage[] = []): Result => ({ k: "apply", state, out });

/** Session / round gate shared by in-game messages. */
function gate(s: State, session: number, round: number): Result | null {
  if (s.peerLeft || session < s.session) return IGNORE; // stale (old session) or peer gone
  if (session > s.session || s.phase === "lobby") return DEFER; // ahead of us
  if (round < s.round) return IGNORE; // old round
  if (round > s.round) return DEFER;
  return null; // same session & round → continue checking
}

function handle(s: State, m: Msg): Result {
  const peer = other(s.role);
  switch (m.t) {
    case "hello": {
      if (m.nonce === s.nonce) return IGNORE; // our own message echoed back
      let cur: State = { ...s, peerPresent: true };
      const started = s.phase !== "lobby";
      // A fresh copy of the peer (new nonce, not a reply) while we are mid-game or
      // after the peer left means the peer re-opened the game: go back to the lobby.
      if (!m.reply && m.nonce !== s.peerNonce && (s.peerLeft || (started && !m.started))) {
        cur = {
          ...createState(s.role, s.nonce),
          session: s.session + (started ? 1 : 0),
          usedQids: s.usedQids,
          peerPresent: true,
        };
      }
      cur = { ...cur, peerNonce: m.nonce };
      if (cur.phase === "lobby") cur = { ...cur, session: Math.max(cur.session, m.session) };
      return apply(cur, m.reply ? [] : [helloMessage(cur, true)]);
    }

    case "start":
      if (s.role === "host" || s.peerLeft || s.phase !== "lobby" || m.session < s.session) return IGNORE;
      return apply(roundReset({ ...s, session: m.session, firstAsker: "host", peerPresent: true, peerNonce: m.nonce }, 1));

    case "question": {
      const g = gate(s, m.session, m.round);
      if (g) return g;
      if (s.phase !== "asking") return IGNORE; // duplicate
      if (m.asker !== peer || askerFor(s, s.round) !== peer) return IGNORE; // wrong player
      const q = m.question;
      return apply({
        ...s,
        phase: "answering",
        question: q,
        usedQids: q.qid >= 0 && !s.usedQids.includes(q.qid) ? [...s.usedQids, q.qid] : s.usedQids,
      });
    }

    case "answer": {
      const g = gate(s, m.session, m.round);
      if (g) return g;
      if (m.player !== peer) return IGNORE;
      if (s.phase === "asking") return DEFER; // question not received yet
      if (s.phase !== "answering" || s.peerAnswer !== null) return IGNORE; // duplicate / late
      const next: State = { ...s, peerAnswer: m.answer };
      if (next.myAnswer === null) return apply(next); // keep it hidden, wait for ours
      // We received the second answer → we coordinate the reveal.
      const hostAnswer = s.role === "host" ? next.myAnswer : m.answer;
      const guestAnswer = s.role === "host" ? m.answer : next.myAnswer;
      return apply({ ...next, phase: "reveal" }, [
        { action: "reveal", session: s.session, round: s.round, hostAnswer, guestAnswer },
      ]);
    }

    case "reveal": {
      const g = gate(s, m.session, m.round);
      if (g) return g;
      if (s.phase === "asking") return DEFER;
      if (s.phase !== "answering") return IGNORE; // already revealed
      if (s.myAnswer === null) return IGNORE; // can't be valid: we haven't answered
      if (s.peerAnswer === null) return DEFER; // their answer still in flight
      const mine = s.role === "host" ? m.hostAnswer : m.guestAnswer;
      const theirs = s.role === "host" ? m.guestAnswer : m.hostAnswer;
      if (mine !== s.myAnswer || theirs !== s.peerAnswer) return IGNORE; // tampered
      return apply({ ...s, phase: "reveal" });
    }

    case "next": {
      if (s.peerLeft || m.session < s.session) return IGNORE;
      if (m.session > s.session || s.phase === "lobby") return DEFER;
      if (m.round <= s.round) return IGNORE; // duplicate (we already moved on)
      if (m.round > s.round + 1 || s.phase !== "reveal") return DEFER; // reveal first
      const expected = m.round > TOTAL_ROUNDS ? null : askerFor(s, m.round);
      if (m.asker !== expected) return IGNORE;
      return apply(roundReset(s, m.round));
    }

    case "leave":
      if (m.session < s.session) return IGNORE;
      return apply({ ...s, peerLeft: true, myRematch: false, peerRematch: false, pending: [] });

    case "rematch": {
      if (s.peerLeft || m.session <= s.session) return IGNORE; // stale or duplicate
      if (m.session > s.session + 1) return IGNORE;
      if (s.phase !== "done") return DEFER; // our last reveal/next is still in flight
      if (m.firstAsker !== other(s.firstAsker) || s.peerRematch) return IGNORE;
      const next = { ...s, peerRematch: true };
      return apply(next.myRematch ? newSession(next) : next);
    }
  }
}

/** Re-tries deferred messages until nothing more can be applied. */
function drain(state: State, out: GameMessage[]): Step {
  let cur = state;
  for (;;) {
    let applied = false;
    const remaining: Msg[] = [];
    for (const p of cur.pending) {
      if (applied) {
        remaining.push(p);
        continue;
      }
      const r = handle({ ...cur, pending: [] }, p);
      if (r.k === "apply") {
        cur = r.state;
        out.push(...r.out);
        applied = true;
      } else if (r.k === "defer") {
        remaining.push(p);
      }
    }
    cur = { ...cur, pending: cur.peerLeft ? [] : remaining };
    if (!applied) return { state: cur, out };
  }
}

export function receive(s: State, raw: unknown): Step {
  const m = parse(raw);
  if (!m) return noop(s);
  const r = handle(s, m);
  if (r.k === "ignore") return noop(s);
  if (r.k === "defer") {
    const key = JSON.stringify(m);
    if (s.pending.length >= MAX_PENDING || s.pending.some((p) => JSON.stringify(p) === key)) return noop(s);
    return noop({ ...s, pending: [...s.pending, m] });
  }
  return drain(r.state, r.out);
}
