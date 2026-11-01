# Dots and Boxes (`dotsandboxes`) 🔵

A two-player Dots and Boxes game for Gulaab's in-call game panel.
React 19 + TypeScript + plain CSS. No runtime dependencies other than React, and no network calls, external assets, fonts, sound, ads or trackers.

## Rules

- The board has **5 × 5 boxes** (6 × 6 dots, 60 lines).
- Players take turns drawing one horizontal or vertical line between two neighbouring dots.
- Closing the 4th side of a box scores **1 point**, and the player **moves again**.
- One line can close **two boxes at once** (2 points, still one extra turn).
- When all 25 boxes are closed, the higher score wins. Draws are detected, but with 25 boxes (an odd number) the default board can't end in a draw.
- **Round 1 is started by the host.** The first player alternates every round (round 2 the guest, round 3 the host, and so on).
- **Play again** starts a rematch once **both** players have tapped it.
- Host is pink `#f9a8d4` and guest is sky blue `#7dd3fc`.

## Files

| File | Purpose |
| --- | --- |
| `index.tsx` | **Default export: the game component.** Also exports the `GameMessage` / `GameProps` types and `meta`. |
| `meta.ts` | Game info for the picker. |
| `logic.ts` | Pure, deterministic rules (board, moves, scoring, winner). |
| `session.ts` | Pure multiplayer protocol (message validation, sync, rematch, leave). |
| `styles.css` | Styles. Every class is prefixed `dnb-` so nothing leaks into the app. |
| `LICENSE` | MIT. |

## Message actions

These are all the actions the game uses, and all of them are listed in `meta.actions`:

| Action | Payload | When it is sent |
| --- | --- | --- |
| `start` | `{ round: number, moves: number[], reply: boolean }` | Once when the component mounts (`reply: false`). The other side answers once with its own state (`reply: true`). This lets a copy that opens late or re-opens catch up. Also sent if a gap in the moves is detected (resync). |
| `move` | `{ round: number, n: number, edge: number }` | When the player draws a line. `n` is the move's index within the round, used for ordering and to drop duplicates. `edge` is 0–59. |
| `rematch` | `{ round: number }` | When the player taps **Play again** on the finished round `round`. |
| `leave` | `{}` | When the player taps **Back** (just before `onExit()`). |

Examples:

```json
{ "action": "move", "round": 1, "n": 0, "edge": 12 }
{ "action": "rematch", "round": 1 }
{ "action": "leave" }
{ "action": "start", "round": 2, "moves": [3, 41, 7], "reply": false }
```

Message sizes:

- The largest possible message is a `start` carrying all 60 moves, about 230 bytes, well under the 512-byte limit. The game also refuses to send anything ≥ 512 bytes.
- Messages are only sent when something happens. Taps are rate-limited to one move per 120 ms, so the game stays under 10 messages per second.

Edge numbering:

- Horizontal lines: `edge = row * 5 + col`, where `row` is 0–5 and `col` is 0–4.
- Vertical lines: `edge = 30 + row * 6 + col`, where `row` is 0–4 and `col` is 0–5.

### How incoming messages are handled

The game never trusts a received message:

- Anything that isn't an object with the expected field types and ranges is ignored. Unknown actions are ignored too.
- These moves are ignored:
  - moves made out of turn
  - lines that are already drawn
  - moves after the game has ended
  - moves after the peer has left
  - moves from an older round
- **Duplicates** are dropped. A move whose index `n` has already been applied is ignored, and so is a repeated `rematch`.
- **Keeping both phones in sync:** each phone stores only the round number and the list of moves. Board, scores, turn and winner are all rebuilt from those moves by `logic.ts`, so both phones always reach the same result. Nothing is random.
- **Recovering after a gap:** if a move arrives from a later round, or with a gap in `n`, the game sends `start` and adopts the peer's longer history once it has replayed and checked it.

## Integration into Gulaab

1. Copy the whole `dotsandboxes/` folder into Gulaab's `games/` folder.
2. Import the component and the meta:

   ```tsx
   import DotsAndBoxes from "./games/dotsandboxes";
   import { meta as dotsAndBoxesMeta } from "./games/dotsandboxes/meta";
   ```

3. Render it with the standard `GameProps`, wiring `send` and `onMessage` to Gulaab's connection:

   ```tsx
   <DotsAndBoxes
     role={isOpener ? "host" : "guest"}
     myName={me.name}
     peerName={peer.name}
     send={(msg) => channel.send(msg)}
     onMessage={(handler) => channel.subscribe(handler)} // must return an unsubscribe function
     onExit={closeGamePanel}
   />
   ```

That's all you need to do. No game logic needs to change.

### Notes for the integrator

- **The panel size** is set by the game itself: `width: 100%`, `max-width: 384px`, `height: 420px`, `max-height: 100%`, and a transparent background. Gulaab's glass panel goes behind it.
- **The font** is inherited, so the game uses Plus Jakarta Sans from the app.
- **The stylesheet** is imported by `index.tsx` (`import "./styles.css"`). Vite, Next.js App Router and similar bundlers handle this out of the box. If your bundler only allows global CSS at the app root, either import `games/dotsandboxes/styles.css` there or rename the file to a CSS module.
- **The handshake** (`start`) doesn't block play. If Gulaab drops messages sent before the other side has subscribed, the game still works: the next `start` or `move` resyncs.
- **`send` and `onMessage` identity:** `send` may change between renders, because the latest one is always used. If `onMessage` changes identity, the game unsubscribes and subscribes again. A stable function is best.
- **Unsubscribing:** the unsubscribe function returned by `onMessage` is called when the component unmounts.
- **Reduced motion:** all animations are switched off under `prefers-reduced-motion: reduce`.
- **Touch targets:** every line has a diamond-shaped target about 48 × 48 px at full panel size (the diamonds tile the board, so each tap hits exactly one line). The Back button and Play again are at least 44 px.
