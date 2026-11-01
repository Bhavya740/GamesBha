/**
 * Pure, deterministic Dots and Boxes rules.
 *
 * No React, no I/O, no randomness: both phones replay the same list of moves
 * and therefore always reach the same board, scores and winner.
 *
 * Edge numbering (for a board of `rows` × `cols` boxes):
 *   - Horizontal edges come first:  e = r * cols + c            r ∈ [0, rows], c ∈ [0, cols)
 *   - Vertical edges follow:        e = H + r * (cols + 1) + c   r ∈ [0, rows), c ∈ [0, cols]
 *     where H = (rows + 1) * cols is the number of horizontal edges.
 * Boxes are numbered b = r * cols + c.
 */

export type Player = "host" | "guest";

/** 0 = nobody, 1 = host, 2 = guest. */
export type Owner = 0 | 1 | 2;

export interface Geometry {
  rows: number;
  cols: number;
  hCount: number;
  edgeCount: number;
  boxCount: number;
  /** For each edge, the 1 or 2 boxes it borders. */
  edgeBoxes: readonly (readonly number[])[];
  /** For each box, its 4 edges: top, bottom, left, right. */
  boxEdges: readonly (readonly number[])[];
}

export function makeGeometry(rows: number, cols: number): Geometry {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
    throw new Error("Board must be at least 1 × 1 boxes");
  }
  const hCount = (rows + 1) * cols;
  const edgeCount = hCount + rows * (cols + 1);
  const boxCount = rows * cols;
  const h = (r: number, c: number) => r * cols + c;
  const v = (r: number, c: number) => hCount + r * (cols + 1) + c;

  const boxEdges: number[][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      boxEdges.push([h(r, c), h(r + 1, c), v(r, c), v(r, c + 1)]);
    }
  }
  const edgeBoxes: number[][] = Array.from({ length: edgeCount }, () => []);
  boxEdges.forEach((edges, b) => edges.forEach((e) => edgeBoxes[e].push(b)));

  return { rows, cols, hCount, edgeCount, boxCount, edgeBoxes, boxEdges };
}

/** The game board used in Gulaab: 5 × 5 boxes (36 dots, 60 lines). */
export const DEFAULT_GEOMETRY = makeGeometry(5, 5);

export interface EdgeCoords {
  dir: "h" | "v";
  /** Grid coordinates (in dot units) of the edge's two end dots. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function edgeCoords(geo: Geometry, e: number): EdgeCoords {
  if (e < geo.hCount) {
    const r = Math.floor(e / geo.cols);
    const c = e % geo.cols;
    return { dir: "h", x1: c, y1: r, x2: c + 1, y2: r };
  }
  const i = e - geo.hCount;
  const r = Math.floor(i / (geo.cols + 1));
  const c = i % (geo.cols + 1);
  return { dir: "v", x1: c, y1: r, x2: c, y2: r + 1 };
}

export const other = (p: Player): Player => (p === "host" ? "guest" : "host");
export const ownerOf = (p: Player): Owner => (p === "host" ? 1 : 2);
export const playerOf = (o: Owner): Player | null => (o === 1 ? "host" : o === 2 ? "guest" : null);

/** Round 1 is started by the host, then the first player alternates every round. */
export function starterForRound(round: number): Player {
  return round % 2 === 1 ? "host" : "guest";
}

export interface Board {
  round: number;
  /** Who drew each edge (0 = not drawn yet). */
  edges: readonly Owner[];
  /** Who completed each box (0 = open). */
  boxes: readonly Owner[];
  scores: { host: number; guest: number };
  turn: Player;
  moveCount: number;
  over: boolean;
  winner: Player | "draw" | null;
  lastEdge: number | null;
  /** Boxes completed by the most recent move (0, 1 or 2). */
  lastCompleted: readonly number[];
}

export function newBoard(geo: Geometry, round: number): Board {
  return {
    round,
    edges: new Array<Owner>(geo.edgeCount).fill(0),
    boxes: new Array<Owner>(geo.boxCount).fill(0),
    scores: { host: 0, guest: 0 },
    turn: starterForRound(round),
    moveCount: 0,
    over: false,
    winner: null,
    lastEdge: null,
    lastCompleted: [],
  };
}

export function isEdgeIndex(geo: Geometry, e: unknown): e is number {
  return typeof e === "number" && Number.isInteger(e) && e >= 0 && e < geo.edgeCount;
}

/**
 * Applies a move by whoever's turn it is. Returns `null` for an invalid move
 * (bad index, line already drawn, or game already over). Never mutates `board`.
 */
export function applyMove(geo: Geometry, board: Board, edge: number): Board | null {
  if (board.over || !isEdgeIndex(geo, edge) || board.edges[edge] !== 0) return null;

  const player = board.turn;
  const mark = ownerOf(player);
  const edges = board.edges.slice();
  edges[edge] = mark;

  const completed = geo.edgeBoxes[edge].filter((b) => geo.boxEdges[b].every((x) => edges[x] !== 0));
  const boxes = board.boxes.slice();
  for (const b of completed) boxes[b] = mark;

  const scores = { ...board.scores };
  scores[player] += completed.length;

  const filled = scores.host + scores.guest;
  const over = filled === geo.boxCount;
  const winner: Board["winner"] = !over
    ? null
    : scores.host === scores.guest
      ? "draw"
      : scores.host > scores.guest
        ? "host"
        : "guest";

  return {
    round: board.round,
    edges,
    boxes,
    scores,
    // Completing at least one box earns another turn.
    turn: completed.length > 0 ? player : other(player),
    moveCount: board.moveCount + 1,
    over,
    winner,
    lastEdge: edge,
    lastCompleted: completed,
  };
}

/** Rebuilds a board from a move list. Returns `null` if any move is invalid. */
export function replay(geo: Geometry, round: number, moves: readonly number[]): Board | null {
  let board: Board | null = newBoard(geo, round);
  for (const e of moves) {
    board = applyMove(geo, board, e);
    if (!board) return null;
  }
  return board;
}
