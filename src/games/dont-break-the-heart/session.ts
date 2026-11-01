/**
 * Heartfall – pure multiplayer protocol (host-authoritative).
 *
 * - The HOST owns the confirmed game: it generates every round's fragile
 *   pieces, validates every move and broadcasts accepted moves.
 * - The GUEST never changes the confirmed board on its own: a guest tap sends
 *   a move *request*; the board updates when the host's confirmation arrives.
 *
 * Messages (all < 512 bytes; every action is in meta.actions):
 *   start   host → guest  full snapshot {gameId, round, fragilePositions, firstPlayer, moves, scoreHost, scoreGuest, rematch}
 *   start   guest → host  hello {hello: true, gameId, player, sync}   ("I'm here" / "please resend the snapshot")
 *   move    guest → host  request      {gameId, round, moveId, player, pieceIndex, crackCount, remainingPieces}  (counts BEFORE the move)
 *   move    host → guest  confirmation {gameId, round, moveId, player, pieceIndex, crackCount, remainingPieces}  (counts AFTER the move)
 *   rematch either        {gameId, round, player}
 *   leave   either        {gameId, player}
 */
import type { GameMessage } from "./index";
import {
  type Board,
  type Config,
  type Player,
  type Scores,
  addResult,
  applyMove,
  emptyBoard,
  isPieceIndex,
  isValidFragile,
  moverOf,
  replay,
  starterForRound,
} from "./logic";

export const MAX_MESSAGE_BYTES = 512;
const MAX_ROUND = 1_000_000;
const MAX_SCORE = 1_000_000;

/** Randomness used only by the host. Injected so the protocol stays pure and testable. */
export interface HostEnv {
  newGameId: () => number;
  newFragile: () => number[];
}

export interface State {
  readonly role: Player;
  /** Confirmed configuration (the guest has none until the first snapshot). */
  readonly cfg: Config | null;
  /** Confirmed moves of the current round. */
  readonly moves: readonly number[];
  readonly board: Board | null;
  /** Session scores at the start of the current round. */
  readonly scoresBefore: Scores;
  readonly peerPresent: boolean;
  readonly peerLeft: boolean;
  readonly myRematch: boolean;
  readonly peerRematch: boolean;
  /** Guest only: piece requested but not yet confirmed by the host. */
  readonly pending: number | null;
}

export interface Step {
  state: State;
  out: GameMessage[];
}

const noop = (state: State): Step => ({ state, out: [] });
const ZERO: Scores = { host: 0, guest: 0 };

export function scoresOf(s: State): Scores {
  return addResult(s.scoresBefore, s.board?.result ?? null);
}

function freshHostRound(env: HostEnv, gameId: number, round: number): Config {
  return { gameId, round, fragile: env.newFragile(), firstPlayer: starterForRound(round) };
}

export function createState(role: Player, env?: HostEnv): State {
  const base: State = {
    role,
    cfg: null,
    moves: [],
    board: null,
    scoresBefore: ZERO,
    peerPresent: false,
    peerLeft: false,
    myRematch: false,
    peerRematch: false,
    pending: null,
  };
  if (role === "guest") return base;
  if (!env) throw new Error("host needs a HostEnv");
  const cfg = freshHostRound(env, env.newGameId(), 1);
  return { ...base, cfg, board: emptyBoard(cfg) };
}

// ---------------------------------------------------------------------------
// Outgoing messages
// ---------------------------------------------------------------------------

export function snapshotMessage(s: State): GameMessage {
  const cfg = s.cfg!;
  return {
    action: "start",
    gameId: cfg.gameId,
    round: cfg.round,
    fragilePositions: cfg.fragile.slice(),
    firstPlayer: cfg.firstPlayer,
    moves: s.moves.slice(),
    scoreHost: s.scoresBefore.host,
    scoreGuest: s.scoresBefore.guest,
    rematch: s.myRematch,
  };
}

export function helloMessage(s: State, sync: boolean): GameMessage {
  return { action: "start", hello: true, gameId: s.cfg?.gameId ?? 0, player: "guest", sync };
}

/** First message a freshly opened copy sends. */
export function mountMessage(s: State): GameMessage {
  return s.role === "host" ? snapshotMessage(s) : helloMessage(s, true);
}

function moveMessage(cfg: Config, moveId: number, player: Player, piece: number, board: Board): GameMessage {
  return {
    action: "move",
    gameId: cfg.gameId,
    round: cfg.round,
    moveId,
    player,
    pieceIndex: piece,
    crackCount: board.cracks,
    remainingPieces: board.remaining,
  };
}

// ---------------------------------------------------------------------------
// Local actions
// ---------------------------------------------------------------------------

/** Whether the local player may tap a piece right now. */
export function canTap(s: State): boolean {
  if (!s.cfg || !s.board || s.peerLeft || s.board.over || s.board.turn !== s.role) return false;
  if (s.role === "host") return s.peerPresent;
  return s.pending === null;
}

export function localTap(s: State, piece: number): Step {
  if (!canTap(s) || !isPieceIndex(piece) || s.board!.used[piece]) return noop(s);
  const cfg = s.cfg!;
  const board = s.board!;
  if (s.role === "host") {
    const next = applyMove(cfg, board, piece)!;
    const moveId = s.moves.length;
    return {
      state: { ...s, moves: [...s.moves, piece], board: next },
      out: [moveMessage(cfg, moveId, "host", piece, next)],
    };
  }
  // Guest: request only. Counts describe the board the guest is looking at (before the move).
  return { state: { ...s, pending: piece }, out: [moveMessage(cfg, s.moves.length, "guest", piece, board)] };
}

/** Guest: the host didn't answer a request in time → drop it and ask for a snapshot. */
export function guestResync(s: State): Step {
  if (s.role !== "guest") return noop(s);
  return { state: { ...s, pending: null }, out: [helloMessage(s, true)] };
}

function hostNewRound(s: State, env: HostEnv): State {
  const cfg = freshHostRound(env, s.cfg!.gameId, s.cfg!.round + 1);
  return {
    ...s,
    cfg,
    moves: [],
    board: emptyBoard(cfg),
    scoresBefore: scoresOf(s),
    myRematch: false,
    peerRematch: false,
  };
}

export function localRematch(s: State, env?: HostEnv): Step {
  if (!s.cfg || !s.board?.over || s.peerLeft || s.myRematch) return noop(s);
  const msg: GameMessage = { action: "rematch", gameId: s.cfg.gameId, round: s.cfg.round, player: s.role };
  if (s.role === "host" && s.peerRematch) {
    const next = hostNewRound(s, env!);
    return { state: next, out: [snapshotMessage(next)] };
  }
  return { state: { ...s, myRematch: true }, out: [msg] };
}

export function localLeave(s: State): Step {
  return { state: s, out: [{ action: "leave", gameId: s.cfg?.gameId ?? 0, player: s.role }] };
}

// ---------------------------------------------------------------------------
// Incoming messages
// ---------------------------------------------------------------------------

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isPlayer = (v: unknown): v is Player => v === "host" || v === "guest";
const isGameId = (v: unknown): v is number => isInt(v, 1, Number.MAX_SAFE_INTEGER);

function isPrefix(a: readonly number[], b: readonly number[]) {
  return a.length <= b.length && a.every((v, i) => b[i] === v);
}

export function receive(s: State, raw: unknown, env?: HostEnv): Step {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return noop(s);
  const m = raw as Record<string, unknown>;
  switch (m.action) {
    case "start":
      return s.role === "host" ? hostOnHello(s, m, env!) : guestOnSnapshot(s, m);
    case "move":
      return s.role === "host" ? hostOnMove(s, m) : guestOnMove(s, m);
    case "rematch":
      return onRematch(s, m, env);
    case "leave":
      return onLeave(s, m);
    default:
      return noop(s);
  }
}

// ----- host side -----

function hostOnHello(s: State, m: Record<string, unknown>, env: HostEnv): Step {
  if (m.hello !== true || m.player !== "guest" || typeof m.sync !== "boolean") return noop(s);
  if (!(m.gameId === 0 || isGameId(m.gameId))) return noop(s);
  if (s.peerLeft) {
    // The guest re-opened the game after leaving: brand-new session, scores reset.
    const next: State = { ...createState("host", env), peerPresent: true };
    return { state: next, out: [snapshotMessage(next)] };
  }
  const next = { ...s, peerPresent: true };
  const needsSnapshot = m.sync || m.gameId !== s.cfg!.gameId;
  return { state: next, out: needsSnapshot ? [snapshotMessage(next)] : [] };
}

function hostOnMove(s: State, m: Record<string, unknown>): Step {
  const cfg = s.cfg!;
  const board = s.board!;
  const { gameId, round, moveId, player, pieceIndex, crackCount, remainingPieces } = m;
  if (
    !isGameId(gameId) ||
    !isInt(round, 1, MAX_ROUND) ||
    !isInt(moveId, 0, 11) ||
    player !== "guest" ||
    !isPieceIndex(pieceIndex) ||
    !isInt(crackCount, 0, 3) ||
    !isInt(remainingPieces, 0, 12)
  ) {
    return noop(s); // malformed
  }
  if (s.peerLeft) return noop(s);
  const resync = { state: { ...s, peerPresent: true }, out: [snapshotMessage(s)] };
  if (gameId !== cfg.gameId) return resync; // guest is on an old/unknown game
  if (round < cfg.round) return noop(s); // stale request from an earlier round
  if (round > cfg.round) return resync;
  if (moveId < s.moves.length) {
    return s.moves[moveId] === pieceIndex ? noop(s) : resync; // duplicate vs. conflicting
  }
  if (moveId > s.moves.length) return resync;
  // Out of turn, finished game, used piece or a guest view that doesn't match ours → reject + resync.
  if (board.over || board.turn !== "guest" || board.used[pieceIndex]) return resync;
  if (crackCount !== board.cracks || remainingPieces !== board.remaining) return resync;

  const next = applyMove(cfg, board, pieceIndex)!;
  return {
    state: { ...s, moves: [...s.moves, pieceIndex], board: next, peerPresent: true },
    out: [moveMessage(cfg, moveId, "guest", pieceIndex, next)],
  };
}

// ----- guest side -----

function guestOnSnapshot(s: State, m: Record<string, unknown>): Step {
  const { gameId, round, fragilePositions, firstPlayer, moves, scoreHost, scoreGuest, rematch } = m;
  if (
    !isGameId(gameId) ||
    !isInt(round, 1, MAX_ROUND) ||
    !isValidFragile(fragilePositions) ||
    !isPlayer(firstPlayer) ||
    firstPlayer !== starterForRound(round) ||
    !Array.isArray(moves) ||
    moves.length > 12 ||
    !moves.every(isPieceIndex) ||
    !isInt(scoreHost, 0, MAX_SCORE) ||
    !isInt(scoreGuest, 0, MAX_SCORE) ||
    typeof rematch !== "boolean"
  ) {
    return noop(s);
  }
  const cfg: Config = { gameId, round, fragile: fragilePositions.slice(), firstPlayer };
  const board = replay(cfg, moves as number[]);
  if (!board) return noop(s);

  const cur = s.cfg;
  const newGame = !cur || gameId > cur.gameId;
  const sameGame = !!cur && gameId === cur.gameId;
  const adopt =
    newGame ||
    (sameGame && (round > cur.round || (round === cur.round && isPrefix(s.moves, moves as number[]))));
  if (!adopt) return noop(s);

  const sameRound = sameGame && round === cur!.round;
  const next: State = {
    ...s,
    cfg,
    moves: (moves as number[]).slice(),
    board,
    scoresBefore: { host: scoreHost, guest: scoreGuest },
    peerPresent: true,
    peerLeft: newGame ? false : s.peerLeft,
    myRematch: sameRound ? s.myRematch : false,
    peerRematch: rematch,
    pending: null,
  };
  // Tell the host we're here and in sync (no snapshot needed).
  return { state: next, out: newGame ? [helloMessage(next, false)] : [] };
}

function guestOnMove(s: State, m: Record<string, unknown>): Step {
  const { gameId, round, moveId, player, pieceIndex, crackCount, remainingPieces } = m;
  if (
    !isGameId(gameId) ||
    !isInt(round, 1, MAX_ROUND) ||
    !isInt(moveId, 0, 11) ||
    !isPlayer(player) ||
    !isPieceIndex(pieceIndex) ||
    !isInt(crackCount, 0, 3) ||
    !isInt(remainingPieces, 0, 12)
  ) {
    return noop(s);
  }
  if (!s.cfg || s.peerLeft) return noop(s);
  const cfg = s.cfg;
  const resync = { state: { ...s, pending: null }, out: [helloMessage(s, true)] };
  if (gameId < cfg.gameId || (gameId === cfg.gameId && round < cfg.round)) return noop(s); // stale
  if (gameId !== cfg.gameId || round > cfg.round) return resync; // we're behind
  if (moveId < s.moves.length) return noop(s); // duplicate confirmation
  if (moveId > s.moves.length) return resync; // we missed something
  const board = s.board!;
  if (player !== moverOf(cfg, moveId) || player !== board.turn) return resync;
  const next = applyMove(cfg, board, pieceIndex);
  // The host's numbers must match what the shared configuration produces.
  if (!next || next.cracks !== crackCount || next.remaining !== remainingPieces) return resync;
  return noop({ ...s, moves: [...s.moves, pieceIndex], board: next, pending: null, peerPresent: true });
}

// ----- both -----

function onRematch(s: State, m: Record<string, unknown>, env?: HostEnv): Step {
  const { gameId, round, player } = m;
  if (!isGameId(gameId) || !isInt(round, 1, MAX_ROUND) || !isPlayer(player)) return noop(s);
  if (player === s.role || !s.cfg || s.peerLeft) return noop(s);
  if (gameId !== s.cfg.gameId || round !== s.cfg.round) return noop(s); // stale
  if (!s.board?.over || s.peerRematch) return noop(s); // not finished / duplicate
  if (s.role === "host" && s.myRematch) {
    const next = hostNewRound(s, env!);
    return { state: next, out: [snapshotMessage(next)] };
  }
  return noop({ ...s, peerRematch: true });
}

function onLeave(s: State, m: Record<string, unknown>): Step {
  const { gameId, player } = m;
  if (!(gameId === 0 || isGameId(gameId)) || !isPlayer(player) || player === s.role) return noop(s);
  // A leave for an older game is stale. (gameId 0 = the peer had no game yet.)
  if (s.cfg && gameId !== 0 && gameId !== s.cfg.gameId) return noop(s);
  return noop({ ...s, peerLeft: true, myRematch: false, peerRematch: false, pending: null });
}

export function messageBytes(m: GameMessage): number {
  return new TextEncoder().encode(JSON.stringify(m)).length;
}
