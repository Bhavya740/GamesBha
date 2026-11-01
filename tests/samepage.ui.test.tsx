import { StrictMode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SamePage from "../src/games/samepage";
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
      <TwoPlayerTest Game={SamePage} />
    </StrictMode>,
  );
  const root = (side: Side) => utils.container.querySelector<HTMLElement>(`.sp-root[data-role="${side}"]`);
  const q = (side: Side, sel: string) => root(side)!.querySelector<HTMLElement>(sel);
  const text = (side: Side) => root(side)!.textContent ?? "";
  const status = (side: Side) => q(side, '[data-testid="sp-status"]')!.textContent!;
  const round = (side: Side) => q(side, '[data-testid="sp-round"]')!.textContent!;
  const wait = (ms = 200) => act(() => vi.advanceTimersByTime(ms));
  const button = (side: Side, label: RegExp) => {
    const b = Array.from(root(side)!.querySelectorAll<HTMLButtonElement>("button")).find((x) => label.test(x.textContent ?? ""));
    if (!b) throw new Error(`no button ${label} on ${side}: ${text(side)}`);
    return b;
  };
  const click = (side: Side, label: RegExp) => fireEvent.click(button(side, label));
  const type = (side: Side, value: string) => fireEvent.change(q(side, "textarea")!, { target: { value } });
  return { utils, root, q, text, status, round, wait, button, click, type };
}

describe("Same Page in the TwoPlayerTest page (real React, 150 ms bridge)", () => {
  it("plays a complete game: start, 10 bank rounds, 2 custom rounds, privacy, reveal, rematch, leave", async () => {
    const t = setup();
    await t.wait();

    // Start screen
    expect(t.text("guest")).toContain("Same Page 💗");
    expect(t.text("guest")).toContain("Two minds. One question. Let's see what you think!");
    expect(t.q("guest", '[data-testid="sp-lobby-wait"]')!.textContent).toContain("Waiting for Priya to start the game");
    expect(t.text("host")).toContain("10 regular rounds");
    expect(() => t.button("guest", /Start Game/)).toThrow(); // only the host can start
    t.click("host", /Start Game/);
    await t.wait();

    const seen: { asker: Side; question: string }[] = [];
    for (let r = 1; r <= 12; r++) {
      const asker: Side = r % 2 ? "host" : "guest";
      const answerer: Side = asker === "host" ? "guest" : "host";
      expect(t.round("host")).toBe(`${r}/12`);
      expect(t.round("guest")).toBe(`${r}/12`);
      expect(t.status(asker)).toBe("Your turn to ask");

      if (r <= 10) {
        expect(t.text(asker)).toContain("Your turn to ask!");
        expect(t.q(answerer, '[data-testid="sp-wait-question"]')!.textContent).toMatch(/is choosing the next question/);
        // Send is disabled until a question is chosen
        expect(t.button(asker, /Send Question/).disabled).toBe(true);
        if (r % 3 === 0) t.click(asker, /Random/);
        else fireEvent.click(t.q(asker, ".sp-option")!);
        expect(t.button(asker, /Send Question/).disabled).toBe(false);
      } else {
        expect(t.text(asker)).toContain("Your Question, Your Curiosity 💗");
        expect(t.text(asker)).toContain(r === 11 ? "Ask Anything! 💬" : "Your Turn to Ask! 💬");
        expect(t.text(answerer)).toContain("Your Question, Your Curiosity 💗");
        // empty question can't be sent
        t.type(asker, "   ");
        expect(t.button(asker, /Send Question/).disabled).toBe(true);
        t.type(asker, `Custom question from ${asker}?`);
      }
      t.click(asker, /Send Question/);
      // Locked for the asker immediately
      expect(t.q(asker, '[data-testid="sp-question"]')).not.toBeNull();
      await t.wait();

      const qa = t.q(asker, '[data-testid="sp-question"] .sp-question-text')!.textContent;
      const qb = t.q(answerer, '[data-testid="sp-question"] .sp-question-text')!.textContent;
      expect(qb).toBe(qa);
      seen.push({ asker, question: qa! });
      expect(t.text(answerer)).toContain(`${asker === "host" ? "Priya" : "Arjun"} has a question for you!`);

      // Empty answer can't be submitted
      expect(t.button(answerer, /Submit Answer/).disabled).toBe(true);
      t.type(answerer, "  \n ");
      expect(t.button(answerer, /Submit Answer/).disabled).toBe(true);

      // First answer (alternate who answers first)
      const first: Side = r % 2 ? "host" : "guest";
      const second: Side = first === "host" ? "guest" : "host";
      const secretFirst = `SECRET-${first}-${r}`;
      const secretSecond = `SECRET-${second}-${r}`;
      t.type(first, secretFirst);
      t.click(first, /Submit Answer/);
      expect(t.text(first)).toContain("Your answer is locked in! 💗");
      expect(t.q(first, "textarea")).toBeNull(); // no editing after submission
      await t.wait();
      // PRIVACY: the other player must not see the answer anywhere in its UI.
      expect(t.text(second)).not.toContain(secretFirst);
      expect(t.q(second, `[data-testid="sp-tag-${first}"]`)!.textContent).toBe("answered ✓");
      expect(t.q(first, '[data-testid="sp-wait-answer"]')!.textContent).toMatch(/Waiting for/);

      t.type(second, secretSecond);
      t.click(second, /Submit Answer/);
      // The 2nd submitter waits for the coordinated reveal: still nothing of the other's answer
      expect(t.text(second)).not.toContain(secretFirst);
      await t.wait(); // its answer reaches the first → first reveals
      await t.wait(); // reveal reaches the second

      for (const side of ["host", "guest"] as Side[]) {
        expect(t.text(side)).toContain("Let's see what you both said! ✨");
        const mine = t.q(side, '[data-testid="sp-answer-mine"] .sp-answer-text')!.textContent;
        const theirs = t.q(side, '[data-testid="sp-answer-peer"] .sp-answer-text')!.textContent;
        expect(mine).toBe(side === first ? secretFirst : secretSecond);
        expect(theirs).toBe(side === first ? secretSecond : secretFirst);
      }
      expect(t.q("guest", '[data-testid="sp-answer-peer"]')!.textContent).toContain("Priya's answer");

      t.click(r % 2 ? "guest" : "host", r === 12 ? /Finish/ : r === 10 ? /custom questions/ : /Next question/);
      await t.wait();
    }

    // No bank question repeated
    expect(new Set(seen.slice(0, 10).map((s) => s.question)).size).toBe(10);

    // Completion
    for (const side of ["host", "guest"] as Side[]) {
      expect(t.text(side)).toContain("That was fun! 💗");
      expect(t.text(side)).toContain("10 regular rounds completed");
      expect(t.text(side)).toContain("2 custom questions completed");
    }

    // Rematch: one click doesn't restart
    t.click("guest", /Play Again/);
    await t.wait();
    expect(t.text("host")).toContain("That was fun!");
    expect(t.q("host", '[data-testid="sp-rematch-status"]')!.textContent).toBe("Arjun wants to play again!");
    t.click("host", /Accept & play again/);
    await t.wait();
    expect(t.round("host")).toBe("1/12");
    expect(t.round("guest")).toBe("1/12");
    expect(t.status("guest")).toBe("Your turn to ask"); // first asker alternated
    expect(t.status("host")).toBe("Arjun is asking");

    // Guest asks; host leaves while answering
    fireEvent.click(t.q("guest", ".sp-option")!);
    t.click("guest", /Send Question/);
    await t.wait();
    t.type("guest", "my answer");
    t.click("guest", /Submit Answer/);
    await t.wait();
    fireEvent.click(t.q("host", ".sp-back")!);
    expect(t.root("host")).toBeNull(); // onExit called → test page shows "Re-open"
    await t.wait();
    expect(t.q("guest", '[data-testid="sp-left"]')!.textContent).toContain("Priya left the game.");
    expect(t.status("guest")).toBe("Priya left");

    // Host re-opens: both are back in the lobby
    fireEvent.click(t.utils.getByText("Re-open game"));
    await t.wait(400);
    expect(t.q("guest", '[data-testid="sp-lobby-wait"]')).not.toBeNull();
    expect(t.button("host", /Start Game/).disabled).toBe(false);
  });

  it("guest leaving while the host is choosing a question", async () => {
    const t = setup();
    await t.wait();
    t.click("host", /Start Game/);
    await t.wait();
    fireEvent.click(t.q("guest", ".sp-back")!);
    await t.wait();
    expect(t.text("host")).toContain("Arjun left the game.");
    fireEvent.click(t.q("host", ".sp-option")!);
    t.click("host", /Send Question/); // can't continue alone
    await t.wait();
    expect(t.q("host", '[data-testid="sp-question"]')).toBeNull();
  });

  it("works with duplicated + invalid messages on the bridge", async () => {
    const t = setup();
    fireEvent.click(t.utils.getByLabelText("Duplicate every message"));
    await t.wait();
    fireEvent.click(t.utils.getByText("Inject invalid messages"));
    t.click("host", /Start Game/);
    await t.wait();
    fireEvent.click(t.q("host", ".sp-option")!);
    t.click("host", /Send Question/);
    await t.wait();
    t.type("host", "A");
    t.click("host", /Submit Answer/);
    t.type("guest", "B");
    t.click("guest", /Submit Answer/);
    await t.wait(500);
    expect(t.q("host", '[data-testid="sp-answer-peer"] .sp-answer-text')!.textContent).toBe("B");
    expect(t.q("guest", '[data-testid="sp-answer-peer"] .sp-answer-text')!.textContent).toBe("A");
    t.click("host", /Next question/);
    await t.wait(500);
    expect(t.round("guest")).toBe("2/12");
    expect(t.status("guest")).toBe("Your turn to ask");
    expect(t.utils.container.querySelectorAll(".tpt-bad")).toHaveLength(0);
  });
});
