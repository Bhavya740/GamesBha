/**
 * Geometry of the glass heart (SVG user units, viewBox 0 0 200 176).
 *
 * The 12 pieces tile the whole board rectangle. Their *visible* glass is the
 * piece clipped to the heart outline; their *touch target* is the unclipped
 * cell, so edge pieces also catch taps just outside the outline. Measured
 * smallest square that fits in any touch target: 37 units (≈ 49 px at the
 * panel's 1.32 px/unit scale), so every piece exceeds 44 × 44 px.
 */

export const VIEW_W = 200;
export const VIEW_H = 176;
export const CENTER = { x: 100, y: 88 };

export const HEART_PATH =
  "M100,172 C38,128 4,96 4,56 C4,24 28,4 56,4 C76,4 92,15 100,30 C108,15 124,4 144,4 C172,4 196,24 196,56 C196,96 162,128 100,172 Z";

type Pt = [number, number];

const RAW: Pt[][] = [
  [[-10, -10], [52, -10], [56, 42.2], [55, 42], [-10, 46]],
  [[52, -10], [100, -10], [100, 50], [56, 42.2]],
  [[100, -10], [148, -10], [144, 43.8], [100, 50]],
  [[148, -10], [210, -10], [210, 48], [150, 43], [144, 43.8]],
  [[-10, 46], [55, 42], [56, 42.2], [44, 97.7], [-10, 94]],
  [[56, 42.2], [100, 50], [106, 90.8], [100, 90], [48, 98], [44, 97.7]],
  [[100, 50], [144, 43.8], [152, 97], [106, 90.8]],
  [[144, 43.8], [150, 43], [210, 48], [210, 92], [152, 97]],
  [[-10, 94], [48, 98], [72, 94.3], [80, 133.2], [70, 132], [-10, 136]],
  [[72, 94.3], [100, 90], [128, 93.8], [122, 138.1], [80, 133.2]],
  [[128, 93.8], [152, 97], [210, 92], [210, 135], [130, 139], [122, 138.1]],
  [[-10, 136], [70, 132], [130, 139], [210, 135], [210, 190], [-10, 190]],
];

/** Visual centroid of each piece's glass (inside the heart). */
export const CENTROIDS: Pt[] = [
  [34, 27], [76, 28], [125, 28], [166, 28],
  [29, 68], [75, 71], [127, 70], [170, 68],
  [53, 113], [101, 113], [147, 114], [97, 148],
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const toPoints = (p: Pt[]) => p.map(([x, y]) => `${x},${y}`).join(" ");

export interface PieceShape {
  /** Glass polygon (rendered clipped to the heart). */
  points: string;
  /** Touch target polygon (clamped to the board rectangle, not clipped to the heart). */
  hit: string;
  cx: number;
  cy: number;
  /** Outward direction for the shatter animation. */
  dx: number;
  dy: number;
  rot: number;
  /** Little zig-zag drawn on a cracked piece. */
  crack: string;
}

export const PIECES: PieceShape[] = RAW.map((poly, i) => {
  const [cx, cy] = CENTROIDS[i];
  const vx = cx - CENTER.x;
  const vy = cy - CENTER.y;
  const len = Math.hypot(vx, vy) || 1;
  const push = 70 + (i % 3) * 18;
  return {
    points: toPoints(poly),
    hit: toPoints(poly.map(([x, y]) => [clamp(x, 0, VIEW_W), clamp(y, 0, VIEW_H)] as Pt)),
    cx,
    cy,
    dx: Math.round((vx / len) * push),
    dy: Math.round((vy / len) * push + 30),
    rot: (i % 2 ? 1 : -1) * (25 + i * 7),
    crack: `M${cx - 12},${cy - 9} L${cx - 3},${cy - 1} L${cx - 7},${cy + 5} L${cx + 4},${cy + 2} L${cx + 12},${cy + 10} M${cx - 3},${cy - 1} L${cx + 5},${cy - 10}`,
  };
});

/** Cracks drawn across the whole heart after the 1st and 2nd fragile piece. */
export const HEART_CRACKS = [
  "M100,30 L95,46 L104,58 L97,72 L103,84",
  "M103,84 L94,100 L106,114 L96,130 L101,150 M104,58 L120,64 L128,80 M97,72 L80,78 L70,92",
];
