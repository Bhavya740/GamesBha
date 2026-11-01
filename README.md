# Dots and Boxes for Gulaab: standalone project

A two-player Dots and Boxes game built to the Gulaab in-call game spec (React 19, TypeScript, Vite, plain CSS). The game lives in its own folder and doesn't depend on anything else in this project, so it can be copied straight into Gulaab.

The project also includes a local **two-player test bench**: two copies of the game side by side, connected by an in-memory bridge with a 150 ms delay.

## Quick start

```bash
npm install
npm run dev        # open http://localhost:5173  → host on the left, guest on the right
npm test           # 28 automated tests (rules, protocol, full UI games)
npm run build      # type-check + production build
```

## Project layout

```
src/
  games/
    dotsandboxes/         ← THE GAME (copy this folder into Gulaab)
      index.tsx           default export Game + GameMessage/GameProps types
      meta.ts             { id, name, emoji, actions }
      logic.ts            pure deterministic rules
      session.ts          pure multiplayer protocol
      styles.css          dnb- prefixed styles
      README.md           rules, message actions, integration guide
      LICENSE
  components/
    TwoPlayerTest.tsx     local dev only: two copies wired via send/onMessage
  App.tsx                 test page
  main.tsx
  app.css                 test page styles only
tests/
  logic.test.ts           rules
  session.test.ts         protocol over a simulated bridge
  ui.test.tsx             full games through the real TwoPlayerTest page
```

Nothing in `games/dotsandboxes/` imports from `components/`, `App.tsx` or `tests/`.

## Integration (for the Gulaab developer)

1. Copy `src/games/dotsandboxes/` into Gulaab's `games/` folder.
2. `import Game from "./games/dotsandboxes";` and `import { meta } from "./games/dotsandboxes/meta";`
3. Render `<Game role myName peerName send onMessage onExit />`, with `send` and `onMessage` connected to Gulaab's existing messaging.

The full message protocol and integration notes are in [src/games/dotsandboxes/README.md](src/games/dotsandboxes/README.md).

## Test bench features

- **Two copies side by side:** host on the left, guest on the right.
- **Same wiring as the Gulaab brief:** messages are JSON round-tripped and delivered after 150 ms.
- **Width toggle:** switch each panel between 384 px and 320 px.
- **"Duplicate every message":** tests that duplicate messages are dropped.
- **"Inject invalid messages":** sends 11 malformed messages to both sides.
- **Back:** tapping Back on either side calls `onExit`. **"Re-open game"** then mounts a fresh copy of that side.
- **"Reset both":** remounts both games.
- **Message log:** lists every message with its size in bytes.

## Testing results

**Automated tests** (`npm test`): **28 / 28 passing**.

*Rules* (`tests/logic.test.ts`):
- Board geometry: 60 lines, 25 boxes.
- The turn passes to the other player when no box is closed.
- Closing a box scores 1 and gives an extra turn.
- One line can close two boxes.
- Invalid moves are rejected and don't change the board.
- 50 random full games: all 25 boxes are claimed and a winner is decided.
- A draw is detected (tested on a 2 × 2 board).
- The first player alternates every round.

*Protocol* (`tests/session.test.ts`), run over a simulated bridge:
- The start handshake sends exactly 4 messages, with no message storm.
- The host moves first. Guest taps out of turn are ignored.
- Extra turns and double boxes stay in sync on both sides.
- Forged out-of-turn moves and moves on already-drawn lines are rejected.
- Delivering every message twice changes nothing.
- 26 kinds of malformed or unknown messages are rejected.
- 20 random full games end with the same win on both sides.
- A draw is detected on both sides.
- Rematch over 4 rounds: both players must accept, and the first player goes host, guest, host, guest.
- Both players tapping Play again at the same moment advances exactly one round.
- Play again doesn't work before the game ends.
- Leaving mid-game freezes the board. Re-opening starts a fresh game.
- A copy that mounts mid-game catches up.
- A lost move is recovered through a resync.
- Every message is under 512 bytes (largest possible is 224 B) and uses only actions listed in `meta.actions`.

*UI* (`tests/ui.test.tsx`): real React in StrictMode, the real TwoPlayerTest page and the 150 ms bridge.
- **Full game:**
  - the host makes the first move
  - a guest tap out of turn is ignored
  - an extra turn follows a closed box
  - a fast double tap is throttled
  - the game is played to the end, with both boards compared after every move
  - the win and lose messages are correct
- **Rematch:**
  - the host sees "Waiting…" and the guest sees "Priya wants a rematch!"
  - after the guest accepts, round 2 starts with the guest moving first
- **Leaving:**
  - the host taps Back mid-game; the guest sees "Priya left" and their board freezes
  - the host re-opens the game, and both sides restart at round 1
- **Messy network:** with every message duplicated and invalid messages injected, a full game plus a simultaneous rematch stays in sync.
- **Message sizes:** every message in the log is under 512 B.

**Manual and real-browser check** (headless Chrome driving the dev server):
- A full game, a rematch, round 2 at 320 px, and a player leaving all worked, with no console errors or warnings.
- At 320 px wide, each panel measured 320 × 420 with no overflow or scrolling.
- Line touch targets measured 47.9 × 47.9 px and the Back button 44 × 44 px.

## Dependencies

- **Runtime:** `react` and `react-dom` only.
- **Development only:** `vite`, `@vitejs/plugin-react`, `typescript`, `@types/react*`, and `vitest`, `jsdom` and `@testing-library/*` for the tests.

## License

MIT. See [LICENSE](LICENSE).
