import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEOMETRY as G,
  applyMove,
  edgeCoords,
  makeGeometry,
  newBoard,
  replay,
  starterForRound,
  type Board,
} from "../src/games/dotsandboxes/logic";

const play = (moves: number[], round = 1) => {
  const b = replay(G, round, moves);
  if (!b) throw new Error("invalid sequence");
  return b;
};

describe("geometry (5 × 5 boxes)", () => {
  it("has 36 dots worth of edges: 30 horizontal + 30 vertical, 25 boxes", () => {
    expect(G.hCount).toBe(30);
    expect(G.edgeCount).toBe(60);
    expect(G.boxCount).toBe(25);
  });
  it("every box has 4 distinct edges and every edge borders 1 or 2 boxes", () => {
    G.boxEdges.forEach((e) => expect(new Set(e).size).toBe(4));
    G.edgeBoxes.forEach((b) => expect([1, 2]).toContain(b.length));
    // border edges: 5 top + 5 bottom + 5 left + 5 right = 20 border edges
    expect(G.edgeBoxes.filter((b) => b.length === 1).length).toBe(20);
  });
  it("edge coordinates are unit-length grid segments", () => {
    for (let e = 0; e < G.edgeCount; e++) {
      const c = edgeCoords(G, e);
      expect(Math.abs(c.x2 - c.x1) + Math.abs(c.y2 - c.y1)).toBe(1);
      expect(c.dir).toBe(e < G.hCount ? "h" : "v");
    }
  });
});

describe("rules", () => {
  it("host starts round 1 and the starter alternates every round", () => {
    expect(starterForRound(1)).toBe("host");
    expect(starterForRound(2)).toBe("guest");
    expect(starterForRound(3)).toBe("host");
    expect(newBoard(G, 2).turn).toBe("guest");
  });

  it("turn passes to the other player when no box is completed", () => {
    const b = play([0]);
    expect(b.turn).toBe("guest");
    expect(b.edges[0]).toBe(1);
    expect(b.scores).toEqual({ host: 0, guest: 0 });
  });

  it("completing a box scores 1 and gives an extra turn", () => {
    // box 0 = top 0, bottom 5, left 30, right 31
    const b = play([0, 5, 30, 31]); // H, G, H, G(completes)
    expect(b.scores).toEqual({ host: 0, guest: 1 });
    expect(b.boxes[0]).toBe(2);
    expect(b.turn).toBe("guest");
    expect(b.lastCompleted).toEqual([0]);
  });

  it("a single line can complete two boxes (2 points, still one extra turn)", () => {
    // box0 {0,5,30,31}, box1 {1,6,31,32}; edge 31 is shared
    const b = play([0, 5, 30, 1, 6, 32, 31]); // last move by host
    expect(b.scores).toEqual({ host: 2, guest: 0 });
    expect([...b.lastCompleted].sort()).toEqual([0, 1]);
    expect(b.boxes[0]).toBe(1);
    expect(b.boxes[1]).toBe(1);
    expect(b.turn).toBe("host");
  });

  it("rejects invalid moves without mutating the board", () => {
    const b = play([0]);
    const snapshot = JSON.stringify(b);
    expect(applyMove(G, b, 0)).toBeNull(); // already drawn
    expect(applyMove(G, b, -1)).toBeNull();
    expect(applyMove(G, b, 60)).toBeNull();
    expect(applyMove(G, b, 1.5)).toBeNull();
    expect(applyMove(G, b, Number.NaN)).toBeNull();
    expect(JSON.stringify(b)).toBe(snapshot);
    expect(replay(G, 1, [0, 0])).toBeNull();
  });

  it("a full random game ends with all 25 boxes owned, a winner, and no more moves", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let game = 0; game < 50; game++) {
      let b: Board = newBoard(G, 1 + (game % 2));
      while (!b.over) {
        const open = b.edges.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0);
        b = applyMove(G, b, open[Math.floor(rnd() * open.length)])!;
      }
      expect(b.moveCount).toBe(60);
      expect(b.scores.host + b.scores.guest).toBe(25);
      expect(b.boxes.every((o) => o !== 0)).toBe(true);
      // 25 is odd, so a draw is impossible on the default board
      expect(b.winner).toBe(b.scores.host > b.scores.guest ? "host" : "guest");
      expect(applyMove(G, b, 0)).toBeNull();
    }
  });

  it("detects a draw (on an even-sized board, e.g. 2 × 2)", () => {
    const g2 = makeGeometry(2, 2);
    // Play deterministic pseudo-random games until one ends 2–2.
    let b: Board | null = null;
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let tries = 0;
    while (!b || b.winner !== "draw") {
      tries++;
      let x = newBoard(g2, 1);
      while (!x.over) {
        const open = x.edges.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0);
        x = applyMove(g2, x, open[Math.floor(rnd() * open.length)])!;
      }
      b = x;
      expect(tries).toBeLessThan(1000);
    }
    expect(b.over).toBe(true);
    expect(b.scores.host + b.scores.guest).toBe(4);
    expect(b.scores.host).toBe(b.scores.guest);
    expect(b.winner).toBe("draw");
  });
});
