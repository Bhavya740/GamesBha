import { StrictMode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Heartfall from "../src/games/dont-break-the-heart";
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
      <TwoPlayerTest Game={Heartfall} />
    </StrictMode>,
  );
  const root = (side: Side) => utils.container.querySelector<HTMLElement>(`.hf-root[data-role="${side}"]`);
  const q = (side: Side, sel: string) => root(side)!.querySelector<HTMLElement>(sel);
  const qa = (side: Side, sel: string) => Array.from(root(side)!.querySelectorAll<HTMLElement>(sel));
  const text = (side: Side) => root(side)!.textContent ?? "";
  const turn = (side: Side) => q(side, '[data-testid="hf-turn"]')!.textContent!;
  const wait = (ms = 200) => act(() => vi.advanceTimersByTime(ms));
  const tap = (side: Side, piece: number) => fireEvent.click(q(side, `[data-hit="${piece}"]`)!);
  const button = (side: Side, re: RegExp) => {
    const b = qa(side, "button").find((x) => re.test(x.textContent ?? "")) as HTMLButtonElement | undefined;
    if (!b) throw new Error(`no ${re} on ${side}: ${text(side)}`);
    return b;
  };
  /** What a player sees of the heart (piece states, strength, scores, round). */
  const view = (side: Side) => ({
    pieces: qa(side, "[data-piece]").map((p) => p.dataset.status),
    strength: q(side, '[data-testid="hf-strength"]')!.textContent,
    host: q(side, '[data-testid="hf-score-host"]')!.textContent,
    guest: q(side, '[data-testid="hf-score-guest"]')!.textContent,
    round: q(side, '[data-testid="hf-round"]')!.textContent,
  });
  const myTurn = (side: Side) => turn(side) === "Your Turn 💗";
  return { utils, root, q, qa, text, turn, wait, tap, button, view, myTurn };
}

/** Plays until the heart breaks, tapping on whichever side has the turn. Returns who made the last move. */
async function playToEnd(t: ReturnType<typeof setup>, pick: (open: number[]) => number) {
  let last: Side = "host";
  for (let guard = 0; guard < 20; guard++) {
    if (t.q("host", '[data-testid="hf-result"]')) return last;
    const side: Side = t.myTurn("host") ? "host" : "guest";
    expect(t.myTurn(side === "host" ? "guest" : "host")).toBe(false);
    const open = t.qa(side, "[data-hit]").map((h) => Number(h.dataset.hit));
    t.tap(side, pick(open));
    last = side;
    await t.wait(400); // request + confirmation round trip
    expect(t.view("guest")).toEqual(t.view("host"));
  }
  throw new Error("game did not end");
}

describe("Heartfall in TwoPlayerTest (real React, 150 ms bridge)", () => {
  it("full match, synced boards, result, rematch with alternating starter, scores kept, leave", async () => {
    const t = setup();
    await t.wait();

    // Host starts; guest got the config
    expect(t.text("host")).toContain("Heartfall 💗");
    expect(t.text("host")).toContain("Take turns removing glass pieces. Don't break the heart!");
    expect(t.turn("host")).toBe("Your Turn 💗");
    expect(t.turn("guest")).toBe("Waiting for Priya...");
    expect(t.qa("guest", "[data-hit]")).toHaveLength(12);
    expect(t.view("guest")).toEqual(t.view("host"));
    expect(t.q("host", '[data-testid="hf-strength"]')!.textContent).toContain("Heart strength: 3/3");

    // Guest can't move out of turn
    t.tap("guest", 0);
    await t.wait();
    expect(t.view("host").pieces.every((s) => s === "intact")).toBe(true);

    // Host first move
    t.tap("host", 0);
    expect(t.q("host", '[data-piece="0"]')!.dataset.status).not.toBe("intact");
    expect(t.q("guest", '[data-piece="0"]')!.dataset.status).toBe("intact"); // in flight
    await t.wait();
    expect(t.view("guest")).toEqual(t.view("host"));
    expect(t.turn("guest")).toBe("Your Turn 💗");

    // Guest move is confirmed by the host before it shows
    t.tap("guest", 11);
    t.tap("guest", 10); // second tap in the same turn is ignored
    expect(t.turn("guest")).toBe("Placing your move…");
    expect(t.q("guest", '[data-piece="11"]')!.dataset.status).toBe("intact");
    await t.wait(400);
    expect(t.q("guest", '[data-piece="11"]')!.dataset.status).not.toBe("intact");
    expect(t.q("guest", '[data-piece="10"]')!.dataset.status).toBe("intact");
    expect(t.view("guest")).toEqual(t.view("host"));

    // Removed piece is no longer a button
    expect(t.q("host", '[data-hit="0"]')).toBeNull();

    // Play to the end
    const loser = await playToEnd(t, (o) => o[0]);
    const winner: Side = loser === "host" ? "guest" : "host";
    const name = { host: "Priya", guest: "Arjun" };
    await t.wait(1000);
    expect(t.q(loser, '[data-testid="hf-result-title"]')!.textContent).toBe("Oops! You broke the heart! 💔");
    expect(t.q(winner, '[data-testid="hf-result-title"]')!.textContent).toBe(`${name[loser]} broke the heart! You win 💗`);
    for (const side of ["host", "guest"] as Side[]) {
      expect(t.q(side, '[data-testid="hf-result-names"]')!.textContent).toBe(`Winner: ${name[winner]} · Broke it: ${name[loser]}`);
      expect(t.q(side, '[data-testid="hf-strength"]')!.textContent).toContain("Heart strength: 0/3");
      expect(t.qa(side, "[data-hit]")).toHaveLength(0); // no moves after the break
    }
    expect(t.view(winner)[winner]).toBe("1");
    expect(t.view(loser)[loser]).toBe("0");

    // Rematch: one side asks, the other must accept
    fireEvent.click(t.button("host", /Play Again/));
    await t.wait();
    expect(t.button("host", /Waiting/).disabled).toBe(true);
    expect(t.q("guest", '[data-testid="hf-rematch-status"]')!.textContent).toBe("Priya wants to play again!");
    expect(t.q("guest", '[data-testid="hf-round"]')!.textContent).toBe("R1");
    fireEvent.click(t.button("guest", /Accept & Play/));
    await t.wait(400);
    for (const side of ["host", "guest"] as Side[]) {
      expect(t.q(side, '[data-testid="hf-round"]')!.textContent).toBe("R2");
      expect(t.q(side, '[data-testid="hf-result"]')).toBeNull();
      expect(t.view(side).pieces.every((s) => s === "intact")).toBe(true);
      expect(t.view(side)[winner]).toBe("1"); // scores preserved
    }
    expect(t.turn("guest")).toBe("Your Turn 💗"); // guest starts round 2
    expect(t.turn("host")).toBe("Waiting for Arjun...");

    // Second full match, then a third with the host starting again
    await playToEnd(t, (o) => o[o.length - 1]);
    await t.wait(1000);
    fireEvent.click(t.button("guest", /Play Again/));
    fireEvent.click(t.button("host", /Play Again/)); // both at once
    await t.wait(400);
    expect(t.view("host").round).toBe("R3");
    expect(t.view("guest").round).toBe("R3");
    expect(t.turn("host")).toBe("Your Turn 💗");
    expect(Number(t.view("host").host) + Number(t.view("host").guest)).toBe(2);

    // Guest exits mid-game
    t.tap("host", 5);
    await t.wait();
    fireEvent.click(t.button("guest", /^Exit$/));
    expect(t.root("guest")).toBeNull(); // onExit was called
    await t.wait();
    expect(t.turn("host")).toBe("Your partner left the game.");
    expect(t.q("host", '[data-testid="hf-left"]')!.textContent).toContain("Your partner left the game.");
    const frozen = t.view("host");
    const hit = t.qa("host", "[data-hit]")[0];
    fireEvent.click(hit);
    await t.wait();
    expect(t.view("host")).toEqual(frozen);

    // Guest comes back → fresh session, scores reset
    fireEvent.click(t.utils.getByText("Re-open game"));
    await t.wait(500);
    expect(t.view("host").round).toBe("R1");
    expect([t.view("host").host, t.view("host").guest]).toEqual(["0", "0"]);
    expect(t.view("guest")).toEqual(t.view("host"));
  });

  it("How to Play opens and closes; all controls are real buttons", async () => {
    const t = setup();
    await t.wait();
    fireEvent.click(t.button("guest", /How to Play\?/));
    expect(t.q("guest", '[data-testid="hf-help"]')!.textContent).toContain("3 hidden pieces are fragile");
    fireEvent.click(t.button("guest", /Got it!/));
    expect(t.q("guest", '[data-testid="hf-help"]')).toBeNull();
  });

  it("stays in sync with duplicated and injected invalid messages", async () => {
    const t = setup();
    fireEvent.click(t.utils.getByLabelText("Duplicate every message"));
    await t.wait();
    fireEvent.click(t.utils.getByText("Inject invalid messages"));
    await t.wait();
    const r = (() => {
      let seed = 3;
      return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    })();
    await playToEnd(t, (o) => o[Math.floor(r() * o.length)]);
    await t.wait(1000);
    expect(t.view("guest")).toEqual(t.view("host"));
    expect(t.utils.container.querySelectorAll(".tpt-bad")).toHaveLength(0);
  });
});
