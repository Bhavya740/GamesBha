import { StrictMode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Game from "../src/games/dotsandboxes";
import TwoPlayerTest from "../src/components/TwoPlayerTest";

type Side = "host" | "guest";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup() {
  const utils = render(
    <StrictMode>
      <TwoPlayerTest Game={Game} />
    </StrictMode>,
  );
  const root = (side: Side) => utils.container.querySelector<HTMLElement>(`.dnb-root[data-role="${side}"]`);
  const q = (side: Side, sel: string) => root(side)!.querySelector<HTMLElement>(sel);
  const qa = (side: Side, sel: string) => Array.from(root(side)!.querySelectorAll<HTMLElement>(sel));
  const status = (side: Side) => q(side, '[data-testid="dnb-status"]')!.textContent!;
  const score = (side: Side, who: Side) => Number(q(side, `[data-testid="dnb-score-${who}"]`)!.textContent);
  /** Board as seen by one side: drawn lines + box owners. */
  const snapshot = (side: Side) => ({
    lines: qa(side, "[data-line]").map((g) => `${g.dataset.line}:${g.getAttribute("class")!.includes("dnb-host") ? "h" : "g"}`).sort(),
    boxes: qa(side, "[data-box]").map((g) => `${g.dataset.box}:${g.dataset.owner}`).sort(),
    scores: [score(side, "host"), score(side, "guest")],
    round: q(side, ".dnb-round")!.textContent,
  });
  const wait = (ms = 200) => act(() => vi.advanceTimersByTime(ms));
  const tap = (side: Side, edge: number) => {
    const el = q(side, `[data-edge="${edge}"]`);
    if (!el) throw new Error(`edge ${edge} not open on ${side}`);
    fireEvent.click(el);
  };
  const isMyTurn = (side: Side) => /^(Your turn|Box! Go again)$/.test(status(side));
  return { utils, root, q, qa, status, score, snapshot, wait, tap, isMyTurn };
}

describe("TwoPlayerTest + Game (real React, 150 ms bridge)", () => {
  it("full game, extra turns, sync after every move, win, rematch, alternating starter, leave", async () => {
    const t = setup();
    await t.wait(); // handshake

    expect(t.status("host")).toBe("Your turn");
    expect(t.status("guest")).toBe("Priya's turn");
    expect(t.q("host", ".dnb-round")!.textContent).toBe("R1");

    // Guest taps out of turn → nothing happens anywhere.
    t.tap("guest", 10);
    await t.wait();
    expect(t.qa("host", "[data-line]")).toHaveLength(0);
    expect(t.qa("guest", "[data-line]")).toHaveLength(0);

    // Host first move
    t.tap("host", 0);
    expect(t.qa("host", "[data-line]")).toHaveLength(1); // instant locally
    expect(t.qa("guest", "[data-line]")).toHaveLength(0); // still in flight
    await t.wait();
    expect(t.snapshot("guest")).toEqual(t.snapshot("host"));
    expect(t.status("guest")).toBe("Your turn");

    // Guest move, host move, guest completes box 0 → extra turn
    t.tap("guest", 5);
    await t.wait();
    t.tap("host", 30);
    await t.wait();
    t.tap("guest", 31);
    await t.wait();
    expect(t.score("host", "guest")).toBe(1);
    expect(t.status("guest")).toBe("Box! Go again");
    expect(t.status("host")).toBe("Arjun goes again");
    expect(t.snapshot("guest")).toEqual(t.snapshot("host"));

    // Rapid double tap within the cooldown only sends one move.
    t.tap("guest", 40);
    t.tap("guest", 41);
    await t.wait();
    expect(t.qa("guest", "[data-line]")).toHaveLength(5);
    expect(t.snapshot("guest")).toEqual(t.snapshot("host"));

    // Play the rest of the game by tapping on whichever side has the turn.
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let safety = 0;
    while (!t.q("host", '[data-testid="dnb-overlay"]')) {
      expect(++safety).toBeLessThan(200);
      const side: Side = t.isMyTurn("host") ? "host" : "guest";
      expect(t.isMyTurn(side === "host" ? "guest" : "host")).toBe(false);
      const open = t.qa(side, "[data-edge]").map((e) => Number(e.dataset.edge));
      t.tap(side, open[Math.floor(rnd() * open.length)]);
      await t.wait();
      expect(t.snapshot("guest")).toEqual(t.snapshot("host"));
    }
    expect(t.q("guest", '[data-testid="dnb-overlay"]')).not.toBeNull();
    expect(t.qa("host", "[data-line]")).toHaveLength(60);
    expect(t.qa("host", "[data-box]")).toHaveLength(25);
    const h = t.score("host", "host");
    const g = t.score("host", "guest");
    expect(h + g).toBe(25);
    if (h > g) {
      expect(t.status("host")).toBe("You win! 🎉");
      expect(t.status("guest")).toBe("Priya wins");
    } else {
      expect(t.status("guest")).toBe("You win! 🎉");
      expect(t.status("host")).toBe("Arjun wins");
    }

    // Rematch: host asks, guest sees request, guest accepts → round 2, guest starts.
    fireEvent.click(t.q("host", ".dnb-btn")!);
    expect(t.q("host", ".dnb-btn")!.textContent).toBe("Waiting…");
    await t.wait();
    expect(t.q("guest", '[data-testid="dnb-rematch-status"]')!.textContent).toBe("Priya wants a rematch!");
    expect(t.q("guest", ".dnb-btn")!.textContent).toBe("Accept rematch");
    fireEvent.click(t.q("guest", ".dnb-btn")!);
    await t.wait();
    for (const side of ["host", "guest"] as Side[]) {
      expect(t.q(side, ".dnb-round")!.textContent).toBe("R2");
      expect(t.q(side, '[data-testid="dnb-overlay"]')).toBeNull();
      expect(t.qa(side, "[data-line]")).toHaveLength(0);
      expect(t.score(side, "host") + t.score(side, "guest")).toBe(0);
    }
    expect(t.status("guest")).toBe("Your turn"); // alternated starter
    expect(t.status("host")).toBe("Arjun's turn");
    t.tap("host", 0); // host can't start round 2
    await t.wait();
    expect(t.qa("guest", "[data-line]")).toHaveLength(0);

    // A few moves, then host leaves mid-game.
    t.tap("guest", 0);
    await t.wait();
    t.tap("host", 1);
    await t.wait();
    fireEvent.click(t.q("host", ".dnb-back")!);
    expect(t.root("host")).toBeNull(); // onExit → test page shows "Re-open"
    await t.wait();
    expect(t.status("guest")).toBe("Priya left the game");
    expect(t.q("guest", '[data-testid="dnb-overlay"]')!.textContent).toContain("Priya left");
    t.tap("guest", 2);
    await t.wait();
    expect(t.qa("guest", "[data-line]")).toHaveLength(2); // board frozen

    // Host re-opens: both start a fresh round 1 with host to move.
    fireEvent.click(t.utils.getByText("Re-open game"));
    await t.wait(400);
    expect(t.status("host")).toBe("Your turn");
    expect(t.status("guest")).toBe("Priya's turn");
    expect(t.snapshot("guest")).toEqual(t.snapshot("host"));
    expect(t.snapshot("host").round).toBe("R1");
    expect(t.snapshot("host").lines).toHaveLength(0);
  });

  it("stays in sync with every message duplicated and with invalid messages injected", async () => {
    const t = setup();
    fireEvent.click(t.utils.getByLabelText("Duplicate every message"));
    await t.wait();
    fireEvent.click(t.utils.getByText("Inject invalid messages"));
    await t.wait();
    let safety = 0;
    while (!t.q("host", '[data-testid="dnb-overlay"]')) {
      expect(++safety).toBeLessThan(200);
      const side: Side = t.isMyTurn("host") ? "host" : "guest";
      const open = t.qa(side, "[data-edge]").map((e) => Number(e.dataset.edge));
      t.tap(side, open[open.length - 1]);
      await t.wait();
      expect(t.snapshot("guest")).toEqual(t.snapshot("host"));
    }
    fireEvent.click(t.q("host", ".dnb-btn")!);
    fireEvent.click(t.q("guest", ".dnb-btn")!); // simultaneous rematch
    await t.wait(400);
    expect(t.snapshot("host").round).toBe("R2");
    expect(t.snapshot("guest").round).toBe("R2");
    expect(t.status("guest")).toBe("Your turn");
  });

  it("all logged messages are under 512 bytes", async () => {
    const t = setup();
    await t.wait();
    t.tap("host", 0);
    await t.wait();
    const sizes = Array.from(t.utils.container.querySelectorAll(".tpt-ok, .tpt-bad")).map((e) => e.textContent);
    expect(sizes.length).toBeGreaterThan(0);
    expect(t.utils.container.querySelectorAll(".tpt-bad")).toHaveLength(0);
  });
});
