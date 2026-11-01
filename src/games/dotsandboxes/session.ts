/**
 * Multiplayer protocol for Dots and Boxes.
 *
 * Everything here is pure: each function takes the current session plus an
 * event and returns the next session and the messages to send. The React
 * component only wires these to `send` / `onMessage`.
 *
 * Messages (all < 512 bytes, every action is listed in meta.actions):
 *   { action: "start",   round, moves: number[], reply }  hello / state sync
 *   { action: "move",    round, n, edge }                 n = move index in round
 *   { action: "rematch", round }                          "play again" for that round
 *   { action: "leave" }                                   player tapped Back
 */
import type { GameMessage } from "./index";
import {
  type Board,
  type Geometry,
  type Player,
  applyMove,
  isEdgeIndex,
  newBoard,
  other,
  replay,
} from "./logic";

export const MAX_MESSAGE_BYTES = 512;

export interface Session {
  readonly geo: Geometry;
  readonly role: Player;
  readonly round: number;
  readonly moves: readonly number[];
  readonly board: Board;
  readonly myRematch: boolean;
  readonly peerRematch: boolean;
  readonly peerLeft: boolean;
  /** True once any valid "start" message from the peer has been received. */
  readonly peerPresent: boolean;
}

export interface Step {
  session: Session;
  out: GameMessage[];
}

export function createSession(role: Player, geo: Geometry): Session {
  return {
    geo,
    role,
    round: 1,
    moves: [],
    board: newBoard(geo, 1),
    myRematch: false,
    peerRematch: false,
    peerLeft: false,
    peerPresent: false,
  };
}

const noop = (session: Session): Step => ({ session, out: [] });

/** The "hello" sent on mount; also used to ask the peer for a resync. */
export function startMessage(s: Session, reply = false): GameMessage {
  return { action: "start", round: s.round, moves: s.moves.slice(), reply };
}

function nextRound(s: Session): Session {
  const round = s.round + 1;
  return { ...s, round, moves: [], board: newBoard(s.geo, round), myRematch: false, peerRematch: false };
}

// ---------------------------------------------------------------------------
// Local actions (this player tapped something)
// ---------------------------------------------------------------------------

export function canMove(s: Session): boolean {
  return !s.peerLeft && !s.board.over && s.board.turn === s.role;
}

export function localMove(s: Session, edge: number): Step {
  if (!canMove(s)) return noop(s);
  const board = applyMove(s.geo, s.board, edge);
  if (!board) return noop(s);
  const n = s.moves.length;
  return {
    session: { ...s, moves: [...s.moves, edge], board },
    out: [{ action: "move", round: s.round, n, edge }],
  };
}

export function localRematch(s: Session): Step {
  if (s.peerLeft || !s.board.over || s.myRematch) return noop(s);
  const out: GameMessage[] = [{ action: "rematch", round: s.round }];
  const next = { ...s, myRematch: true };
  return { session: next.peerRematch ? nextRound(next) : next, out };
}

export function localLeave(s: Session): Step {
  return { session: s, out: [{ action: "leave" }] };
}

// ---------------------------------------------------------------------------
// Incoming messages (never trusted)
// ---------------------------------------------------------------------------

const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

const MAX_ROUND = 1_000_000;

function isPrefix(a: readonly number[], b: readonly number[]): boolean {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function receive(s: Session, raw: unknown): Step {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return noop(s);
  const msg = raw as Record<string, unknown>;

  switch (msg.action) {
    case "move":
      return receiveMove(s, msg);
    case "rematch":
      return receiveRematch(s, msg);
    case "leave":
      return noop({ ...s, peerLeft: true, myRematch: false, peerRematch: false });
    case "start":
      return receiveStart(s, msg);
    default:
      return noop(s); // unknown action
  }
}

function receiveMove(s: Session, msg: Record<string, unknown>): Step {
  const { round, n, edge } = msg;
  if (!isInt(round, 1, MAX_ROUND) || !isInt(n, 0, s.geo.edgeCount - 1) || !isEdgeIndex(s.geo, edge)) {
    return noop(s);
  }
  if (s.peerLeft || round < s.round) return noop(s); // stale

  // The peer is ahead of us (we missed something): ask for its full state.
  if (round > s.round || n > s.moves.length) return { session: s, out: [startMessage(s)] };

  // Already have this move index → duplicate (or conflicting) message.
  if (n < s.moves.length) return noop(s);

  // Out-of-turn moves are ignored.
  if (s.board.turn !== other(s.role)) return noop(s);

  const board = applyMove(s.geo, s.board, edge);
  if (!board) return noop(s); // line already drawn / game over
  return noop({ ...s, moves: [...s.moves, edge], board });
}

function receiveRematch(s: Session, msg: Record<string, unknown>): Step {
  if (!isInt(msg.round, 1, MAX_ROUND)) return noop(s);
  if (s.peerLeft || msg.round !== s.round || s.peerRematch) return noop(s);
  const next = { ...s, peerRematch: true };
  return noop(next.myRematch && next.board.over ? nextRound(next) : next);
}

function receiveStart(s: Session, msg: Record<string, unknown>): Step {
  const { round, moves, reply } = msg;
  if (
    !isInt(round, 1, MAX_ROUND) ||
    typeof reply !== "boolean" ||
    !Array.isArray(moves) ||
    moves.length > s.geo.edgeCount ||
    !moves.every((e) => isEdgeIndex(s.geo, e))
  ) {
    return noop(s);
  }
  const theirMoves = moves as number[];

  // The peer re-opened the game after leaving: start fresh together.
  let cur: Session = s.peerLeft ? { ...createSession(s.role, s.geo), peerPresent: true } : s;
  cur = { ...cur, peerPresent: true };

  const theirBoard = replay(cur.geo, round, theirMoves);
  if (theirBoard) {
    const sameRound = round === cur.round;
    const adopt =
      round > cur.round ||
      (sameRound && theirMoves.length > cur.moves.length && isPrefix(cur.moves, theirMoves)) ||
      // Diverged histories should be impossible; if it ever happens the host's version wins.
      (sameRound && cur.role === "guest" && !isPrefix(cur.moves, theirMoves) && !isPrefix(theirMoves, cur.moves));
    if (adopt) {
      cur = sameRound
        ? { ...cur, moves: theirMoves.slice(), board: theirBoard }
        : { ...cur, round, moves: theirMoves.slice(), board: theirBoard, myRematch: false, peerRematch: false };
    }
  }

  return { session: cur, out: reply ? [] : [startMessage(cur, true)] };
}

/** Size of a message as it travels on the wire (UTF-8 JSON). */
export function messageBytes(msg: GameMessage): number {
  return new TextEncoder().encode(JSON.stringify(msg)).length;
}
