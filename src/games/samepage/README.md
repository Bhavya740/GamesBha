# Same Page 💗 (`samepage`)

*Two minds. One question. Let's see what you think!*

Same Page is a question-and-answer game for two people meeting on a Gulaab video call:

- **Each round:** one player asks a question. Both players answer privately, then both answers are revealed at the same time so the players can talk about them on the call.
- **Built with:** React 19, TypeScript and plain CSS. React is the only runtime dependency.
- **Nothing external:** no network calls, external assets or fonts, sound, ads or trackers.

## Objective

Get to know each other. There is no score: the point is the conversation each reveal starts.

## Rules

1. **Players and starting:**
   - The **host** (the player who opened the game) taps **Start Game**. The guest sees *"Waiting for [host] to start the game..."*.
   - Start Game is enabled once the guest's copy of the game has connected.
2. **Rounds 1–10 (bank questions):**
   - The asker picks a question from a local bank: 6 categories with 12 questions each.
   - The asker can pick one of 3 suggestions, **↻** to see other suggestions, or **🎲 Random**.
   - Questions already asked aren't suggested again. This carries over into rematches until the bank runs out.
3. **Rounds 11–12 (custom questions):** under the heading **Your Question, Your Curiosity 💗**, each player writes one question of their own.
   - Round 11: *Ask Anything! 💬*, asked by the session's first asker (the host in game 1).
   - Round 12: *Your Turn to Ask! 💬*, asked by the other player.
4. **Who asks:** the asker alternates every round:
   - Odd rounds: the session's first asker.
   - Even rounds: the other player.
   - In game 1 the host asks rounds 1, 3, 5, 7, 9 and 11, and the guest asks rounds 2, 4, 6, 8, 10 and 12.
5. **Answering:**
   - Both players answer every question, including the asker.
   - An answer can't be empty and can't be edited once it's submitted.
   - After submitting, a player sees *"Your answer is locked in! 💗 Waiting for [name]..."*.
6. **Privacy:**
   - The other player's answer is never displayed before the reveal: not in a preview, notification, tag or any other part of the screen.
   - Each player only sees whether the other has **answered ✓**, never what they wrote.
7. **Reveal:** once both answers are in, both are shown together on both phones under **"Let's see what you both said! ✨"**. The host's answer is in pink (`#f9a8d4`) and the guest's in sky blue (`#7dd3fc`).
8. **Moving on:** after the reveal, either player taps **Next question**. This button is labelled **Next: custom questions 💬** after round 10 and **Finish 💗** after round 12.
9. **End of the game:** after 12 questions, **That was fun! 💗** shows "10 regular rounds completed" and "2 custom questions completed", with **Play Again** and **Back** buttons.

Text limits keep every message under 512 bytes. They are measured as JSON-encoded UTF-8 bytes; the on-screen counter shows how many are left.

- A custom question can be up to 220 bytes.
- An answer can be up to 180 bytes.

## How to play (on the call)

1. The host taps **Start Game**.
2. Whoever's turn it is picks a question, or writes one in rounds 11–12, and taps **Send Question**.
3. Both players type an answer and tap **Submit Answer**.
4. When both answers are in, they're revealed together. Talk about them.
5. Either player taps **Next question**. After 12 questions, tap **Play Again** for another game, or **Back** to leave.

## Files

| File | Purpose |
| --- | --- |
| `index.tsx` | **Default export: the game component.** Also exports the `GameMessage` / `GameProps` types and `meta`. |
| `meta.ts` | Game info and the list of message actions. |
| `session.ts` | Pure state machine and multiplayer protocol: validation, sync, reveal, rematch and leave. |
| `questions.ts` | Local question bank (6 categories × 12 questions). |
| `styles.css` | Styles. Every class is prefixed `sp-`. |
| `LICENSE` | MIT. |

No `assets/` folder: the game uses no images. Its icons are emoji and inline SVG.

## Message actions

These are all the actions the game uses, and all of them are listed in `meta.actions`:

| Action | Payload | Sent by / when |
| --- | --- | --- |
| `start` (hello) | `{ session, round: 0, started: boolean, reply: boolean, nonce: number }` | Both players, once when the game opens (`reply: false`). Each side answers once (`reply: true`). |
| `start` | `{ session, round: 1, nonce }` | The host, on **Start Game**. |
| `question` | `{ session, round, question, asker, qid, category }` | The asker, on **Send Question**. `qid` is the question's index in the bank, or `-1` (with category `"custom"`) in rounds 11–12. |
| `answer` | `{ session, round, answer, player }` | Each player, on **Submit Answer**. |
| `reveal` | `{ session, round, hostAnswer, guestAnswer }` | The player who **receives the second answer**. |
| `next` | `{ session, round, asker }` | Either player, on **Next question**. `round` is the new round (2–13). `asker` is `null` for round 13, which means the game is complete. |
| `leave` | `{ session }` | On **Back**, just before `onExit()`. |
| `rematch` | `{ session, firstAsker }` | On **Play Again**. `session` is the new session number and `firstAsker` the player who will ask first in it. |

The `nonce` is a random number picked when a copy of the game opens. It only identifies that copy, so the other side can tell when the game has been re-opened. It never affects questions or answers.

Examples:

```json
{"action":"start","session":1,"round":1,"nonce":918273645}
{"action":"question","session":1,"round":1,"question":"Which country would you love to visit?","asker":"host","qid":36,"category":"travel"}
{"action":"answer","session":1,"round":1,"answer":"Japan","player":"host"}
{"action":"reveal","session":1,"round":1,"hostAnswer":"Japan","guestAnswer":"Switzerland"}
{"action":"next","session":1,"round":2,"asker":"guest"}
{"action":"leave","session":1}
{"action":"rematch","session":2,"firstAsker":"guest"}
```

**Message size:** the largest message possible is a `reveal` with two maximum-length answers, which is under 480 bytes. The game also refuses to send anything of 512 bytes or more.

**Message rate:** messages are only sent when a player does something, so the game stays far below 10 messages per second.

## Multiplayer synchronisation

Both phones keep the same shared state:

- the session number
- the round number
- the first asker of the session
- the phase: `lobby → asking → answering → reveal → … → done`
- the locked question

Who asks a round is calculated from the round number on each phone, so both always agree. The only randomness is on the asker's own phone (suggestions and **🎲 Random**), and the chosen question is sent to the other player. The two phones never pick questions independently.

**Every incoming message is checked:**

- **Format:** it must be an object with the right types and ranges and a known action. Text must be non-empty, already cleaned and within the byte limit.
- **Bank questions:** the text must exactly match the bank entry for `qid`, so a made-up question can't pass as a bank question.
- **Session:** messages from an **older session** are ignored, so a previous game can't affect a rematch. A `leave` from an older session is ignored too.
- **Turn:**
  - A `question` from the player who isn't asking that round is ignored.
  - An `answer` claiming to be from yourself is ignored.
- **Duplicates:**
  - Only the first answer from each player in a round is kept.
  - Repeated `question`, `reveal`, `next` and `rematch` messages are ignored.
  - A player can't submit twice.
- **Early messages:** a valid message that arrives too early is **held back** and applied once the game catches up. Examples:
  - an `answer` before its `question`
  - a `next` before the reveal
  - a message for the next session before the rematch
  
  Up to 16 messages can be held back. This copes with delayed and out-of-order delivery.
- **Order of play:** `next` can't start a round before the current round has been revealed, on either phone.

### Reveal coordination

1. Each player sends their own answer when they submit it.
2. A phone that receives the other player's answer **before** its own player has answered keeps it hidden in memory.
3. The player who **receives the second answer** reveals on their phone and sends `reveal { hostAnswer, guestAnswer }`.
4. The other phone, which submitted second, doesn't reveal on its own. It waits for that `reveal` and accepts it only if:
   - the session and round match
   - its own player has answered
   - it has received the other player's answer
   - **both answers in the message exactly match** the ones it holds
   
   A `reveal` with altered answers is ignored.
5. If both submit at the same moment, both phones receive the second answer and both reveal. Each phone then ignores the extra `reveal` it receives.

## Rematch

- Either player can tap **Play Again** on the final screen. It sends `rematch` and shows *"Waiting for [name] to agree…"*. The other player sees *"[name] wants to play again!"* and an **Accept & play again** button.
- A new session starts **only when both players have agreed**. One tap alone never restarts the game. If both tap at the same moment, exactly one new session starts.
- The new session starts at round 1. Answers, questions and the custom rounds are all cleared.
- **The first asker alternates:** game 1 the host, game 2 the guest, game 3 the host, and so on.
- Every message carries the session number, so anything still in flight from the previous game is ignored.

## Leave handling

- **Back:**
  - The **Back** button is always visible in the header, and the final screen has a second Back button.
  - Tapping Back sends `leave` and then calls `onExit()`.
- **When the other player leaves**, at any stage (start screen, asking, answering, reveal or final screen):
  - the remaining player sees *"[name] left the game."* with a Back button
  - the game is frozen: no starting, asking, answering, next or rematch
  - any later messages are ignored
- **If the other player re-opens the game,** its new copy sends a hello with a new `nonce`. Both phones then return to the start screen for a fresh game.
- **Unmounting:** the message subscription is cleaned up when the component unmounts (the unsubscribe function returned by `onMessage` is called).

## Integration into Gulaab

1. Copy the `samepage/` folder into Gulaab's `games/` folder.
2. Import it:

   ```tsx
   import SamePage from "./games/samepage";
   import { meta as samePageMeta } from "./games/samepage/meta";
   ```

3. Render it with the standard props, wiring `send` and `onMessage` to Gulaab's existing connection:

   ```tsx
   <SamePage role={role} myName={me} peerName={peer} send={send} onMessage={onMessage} onExit={close} />
   ```

No other changes are needed.

### Notes for the integrator

- **Layout:** `width: 100%`, `max-width: 384px`, `height: 420px`, `max-height: 100%`, transparent background. It works at 320 px wide with no page scrolling. Very long answers scroll inside their own answer card.
- **Font:** inherited from the app.
- **Touch targets:** every button, the category picker and the text boxes are at least 44 px tall.
- **Text boxes:** they use a 16 px font so iOS doesn't zoom in when one is tapped.
- **Reduced motion:** all animations are switched off under `prefers-reduced-motion: reduce`.
- **Stylesheet:** `index.tsx` imports `./styles.css`, the same way the Dots and Boxes game does. If your bundler only allows global CSS at the app root, import the file there instead.
