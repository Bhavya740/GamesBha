import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import { CATEGORIES, QUESTIONS, categoryOf } from "./questions";
import {
  ANSWER_MAX_BYTES,
  CUSTOM_ROUNDS,
  MAX_MESSAGE_BYTES,
  QUESTION_MAX_BYTES,
  REGULAR_ROUNDS,
  TOTAL_ROUNDS,
  askerFor,
  canAnswer,
  canStart,
  cleanText,
  createState,
  helloMessage,
  isCustomRound,
  isValidAnswer,
  isValidCustomQuestion,
  jsonBytes,
  localAnswer,
  localLeave,
  localNext,
  localQuestion,
  localRematch,
  localStart,
  messageBytes,
  receive,
  type Player,
  type Question,
  type State,
  type Step,
} from "./session";

export { meta } from "./meta";

// ---------------------------------------------------------------------------
// Gulaab game interface (must match the developer brief exactly)
// ---------------------------------------------------------------------------

export type GameMessage = {
  action: string;
  [key: string]: string | number | boolean | number[] | null;
};

export interface GameProps {
  role: "host" | "guest";
  myName: string;
  peerName: string;
  send: (msg: GameMessage) => void;
  onMessage: (handler: (msg: GameMessage) => void) => () => void;
  onExit: () => void;
}

// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0");
const pc = (p: Player) => (p === "host" ? "sp-host" : "sp-guest");

export default function Game(props: GameProps): React.JSX.Element {
  const { role, onMessage, onExit } = props;
  const myName = props.myName.trim() || "You";
  const peerName = props.peerName.trim() || "Your partner";
  const peer: Player = role === "host" ? "guest" : "host";

  // The nonce only identifies this mounted copy (to detect a re-opened peer);
  // it never influences questions or answers.
  const [state, setState] = useState<State>(() => createState(role, Math.floor(Math.random() * 2 ** 31)));
  const stateRef = useRef(state);
  const sendRef = useRef(props.send);

  useLayoutEffect(() => {
    sendRef.current = props.send;
  });

  const safeSend = useCallback((msg: GameMessage) => {
    const bytes = messageBytes(msg);
    if (bytes >= MAX_MESSAGE_BYTES) {
      console.warn(`[samepage] dropped oversize message (${bytes} B)`, msg.action);
      return;
    }
    try {
      sendRef.current(msg);
    } catch (err) {
      console.warn("[samepage] send failed", err);
    }
  }, []);

  const commit = useCallback(
    (step: Step) => {
      if (step.state !== stateRef.current) {
        stateRef.current = step.state;
        setState(step.state);
      }
      step.out.forEach(safeSend);
    },
    [safeSend],
  );

  // Subscribe to the peer; unsubscribe on unmount.
  useEffect(() => {
    const unsubscribe = onMessage((msg) => commit(receive(stateRef.current, msg)));
    return () => {
      unsubscribe();
    };
  }, [onMessage, commit]);

  // Presence handshake once on mount.
  useEffect(() => {
    safeSend(helloMessage(stateRef.current));
  }, [safeSend]);

  const act = (fn: (s: State) => Step) => commit(fn(stateRef.current));
  const back = () => {
    act(localLeave);
    onExit();
  };

  const s = state;
  const nameOf = (p: Player) => (p === role ? myName : peerName);
  const asker = s.round >= 1 && s.round <= TOTAL_ROUNDS ? askerFor(s, s.round) : null;
  const iAsk = asker === role;

  // ----- header status -----
  let status: string;
  if (s.peerLeft) status = `${peerName} left`;
  else if (s.phase === "lobby") status = role === "host" ? (s.peerPresent ? "Ready to start" : `Waiting for ${peerName}…`) : `Waiting for ${peerName}`;
  else if (s.phase === "asking") status = iAsk ? "Your turn to ask" : `${peerName} is asking`;
  else if (s.phase === "answering") status = s.myAnswer ? "Answer locked ✓" : "Answer privately";
  else if (s.phase === "reveal") status = "Answers revealed ✨";
  else status = "Game complete 💗";

  const roundLabel =
    s.phase === "lobby" ? "Lobby" : s.phase === "done" ? `${TOTAL_ROUNDS}/${TOTAL_ROUNDS}` : `${s.round}/${TOTAL_ROUNDS}`;

  const playerTag = (p: Player): string => {
    if (s.peerLeft && p === peer) return "left";
    if (s.phase === "asking") return asker === p ? "asking…" : "waiting";
    if (s.phase === "answering") return (p === role ? s.myAnswer !== null : s.peerAnswer !== null) ? "answered ✓" : "writing…";
    if (s.phase === "reveal") return "revealed";
    if (s.phase === "done") return (p === role ? s.myRematch : s.peerRematch) ? "ready ✓" : "done";
    return p === "host" ? "host" : "guest";
  };
  const isActive = (p: Player) =>
    !s.peerLeft &&
    ((s.phase === "asking" && asker === p) ||
      (s.phase === "answering" && (p === role ? s.myAnswer === null : s.peerAnswer === null)));

  const stageKey = `${s.session}-${s.round}-${s.phase}`;

  return (
    <div className={`sp-root ${role === "host" ? "sp-me-host" : "sp-me-guest"}`} data-role={role}>
      <div className="sp-header">
        <button type="button" className="sp-back" onClick={back} aria-label="Back">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="sp-status" role="status" aria-live="polite" data-testid="sp-status">
          {status}
        </div>
        <div className="sp-round" data-testid="sp-round">
          {roundLabel}
        </div>
      </div>

      <div className="sp-players">
        {[role, peer].map((p) => (
          <div key={p} className={`sp-pill ${pc(p)} ${isActive(p) ? "sp-active" : ""}`} data-player={p}>
            <span className="sp-pill-name">
              {nameOf(p)}
              {p === role ? " (You)" : ""}
            </span>
            <span className="sp-pill-tag" data-testid={`sp-tag-${p}`}>
              {playerTag(p)}
            </span>
          </div>
        ))}
      </div>

      <div className="sp-stage" key={stageKey}>
        {s.phase === "lobby" && <Lobby s={s} myName={myName} peerName={peerName} onStart={() => act(localStart)} />}

        {s.phase === "asking" && iAsk && !isCustomRound(s.round) && (
          <AskBank s={s} onSend={(q) => act((st) => localQuestion(st, q))} />
        )}
        {s.phase === "asking" && iAsk && isCustomRound(s.round) && (
          <AskCustom round={s.round} onSend={(text) => act((st) => localQuestion(st, { text, qid: -1, category: "custom" }))} />
        )}
        {s.phase === "asking" && !iAsk && <WaitForQuestion round={s.round} peerName={peerName} />}

        {s.phase === "answering" && s.question && (
          <Answer s={s} iAsked={iAsk} peerName={peerName} onSubmit={(t) => act((st) => localAnswer(st, t))} />
        )}

        {s.phase === "reveal" && s.question && s.myAnswer !== null && s.peerAnswer !== null && (
          <Reveal s={s} role={role} peerName={peerName} onNext={() => act(localNext)} />
        )}

        {s.phase === "done" && (
          <Done s={s} peerName={peerName} onRematch={() => act(localRematch)} onBack={back} />
        )}

        {s.peerLeft && (
          <div className="sp-overlay" data-testid="sp-left">
            <div className="sp-card">
              <div className="sp-h2 sp-warn">{peerName} left the game.</div>
              <p className="sp-sub">This round can't continue without them.</p>
              <button type="button" className="sp-btn" onClick={back}>
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function Lobby({ s, myName, peerName, onStart }: { s: State; myName: string; peerName: string; onStart: () => void }) {
  const isHost = s.role === "host";
  const hostName = isHost ? myName : peerName;
  return (
    <div className="sp-col sp-center sp-fill">
      <div className="sp-title">Same Page 💗</div>
      <p className="sp-tagline">Two minds. One question. Let's see what you think!</p>
      <div className="sp-vs">
        <span className={pc(s.role)}>{myName}</span>
        <span className="sp-muted">&amp;</span>
        <span className={pc(s.role === "host" ? "guest" : "host")}>{peerName}</span>
      </div>
      <p className="sp-sub">Take turns asking. Both answer privately, then reveal together and talk about it.</p>
      <div className="sp-chips">
        <span className="sp-chip">{REGULAR_ROUNDS} regular rounds</span>
        <span className="sp-chip">+ {CUSTOM_ROUNDS} custom questions</span>
      </div>
      {isHost ? (
        <button type="button" className="sp-btn" onClick={onStart} disabled={!canStart(s)}>
          {s.peerPresent ? "Start Game" : `Waiting for ${peerName}…`}
        </button>
      ) : (
        <p className="sp-waiting" data-testid="sp-lobby-wait">
          Waiting for {hostName} to start the game<Dots />
        </p>
      )}
    </div>
  );
}

/** Picks `n` question ids from a category, preferring unused ones (local UI only). */
function sample(category: string, used: readonly number[], n: number, include?: number): number[] {
  const all = QUESTIONS.filter((q) => q.category === category).map((q) => q.qid);
  const fresh = all.filter((id) => !used.includes(id) && id !== include);
  const stale = all.filter((id) => used.includes(id) && id !== include);
  const shuffle = (a: number[]) => a.map((v) => [Math.random(), v] as const).sort((x, y) => x[0] - y[0]).map(([, v]) => v);
  const picked = [...shuffle(fresh), ...shuffle(stale)].slice(0, include === undefined ? n : n - 1);
  return include === undefined ? picked : [include, ...picked];
}

function AskBank({ s, onSend }: { s: State; onSend: (q: Question) => void }) {
  const [category, setCategory] = useState(() => CATEGORIES[(s.round - 1) % CATEGORIES.length].id);
  const [options, setOptions] = useState(() => sample(category, s.usedQids, 3));
  const [selected, setSelected] = useState<number | null>(null);

  const pickCategory = (id: string) => {
    setCategory(id);
    setOptions(sample(id, s.usedQids, 3));
    setSelected(null);
  };
  const shuffle = () => {
    setOptions(sample(category, s.usedQids, 3));
    setSelected(null);
  };
  const random = () => {
    const fresh = QUESTIONS.filter((q) => !s.usedQids.includes(q.qid));
    const pool = fresh.length ? fresh : QUESTIONS;
    const q = pool[Math.floor(Math.random() * pool.length)];
    setCategory(q.category);
    setOptions(sample(q.category, s.usedQids, 3, q.qid));
    setSelected(q.qid);
  };
  const send = () => {
    if (selected === null) return;
    const q = QUESTIONS[selected];
    onSend({ text: q.text, qid: q.qid, category: q.category });
  };

  return (
    <div className="sp-col sp-fill">
      <div className="sp-h2 sp-me">Your turn to ask!</div>
      <p className="sp-sub">Choose something interesting and get to know each other.</p>
      <div className="sp-row">
        <select
          className="sp-select"
          value={category}
          onChange={(e) => pickCategory(e.target.value)}
          aria-label="Question category"
        >
          {CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.emoji} {c.label}
            </option>
          ))}
        </select>
        <button type="button" className="sp-icon-btn" onClick={shuffle} aria-label="Show other suggestions" title="Other suggestions">
          ↻
        </button>
      </div>
      <div className="sp-options" role="radiogroup" aria-label="Suggested questions">
        {options.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected === id}
            className={`sp-option ${selected === id ? "sp-selected" : ""} ${s.usedQids.includes(id) ? "sp-used" : ""}`}
            onClick={() => setSelected(id)}
            data-qid={id}
          >
            {QUESTIONS[id].text}
          </button>
        ))}
      </div>
      <div className="sp-row">
        <button type="button" className="sp-btn-ghost" onClick={random}>
          🎲 Random
        </button>
        <button type="button" className="sp-btn sp-grow" onClick={send} disabled={selected === null}>
          Send Question
        </button>
      </div>
    </div>
  );
}

function CustomBanner() {
  return (
    <div className="sp-banner">
      <div className="sp-banner-title">Your Question, Your Curiosity 💗</div>
      <div className="sp-banner-sub">Now it's your turn to ask something you've always wanted to know.</div>
    </div>
  );
}

function AskCustom({ round, onSend }: { round: number; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const clean = cleanText(text);
  const valid = isValidCustomQuestion(clean);
  const first = round === REGULAR_ROUNDS + 1;
  return (
    <div className="sp-col sp-fill">
      <CustomBanner />
      <div className="sp-h2 sp-me">{first ? "Ask Anything! 💬" : "Your Turn to Ask! 💬"}</div>
      <p className="sp-sub">Ask your own question. Make it interesting!</p>
      <LimitedTextarea
        value={text}
        onChange={setText}
        maxBytes={QUESTION_MAX_BYTES}
        placeholder="Type your own question..."
        label="Your custom question"
      />
      <button type="button" className="sp-btn" onClick={() => valid && onSend(clean)} disabled={!valid}>
        Send Question
      </button>
    </div>
  );
}

function WaitForQuestion({ round, peerName }: { round: number; peerName: string }) {
  return (
    <div className="sp-col sp-center sp-fill">
      {isCustomRound(round) && <CustomBanner />}
      <div className="sp-pulse" aria-hidden="true">
        💭
      </div>
      <p className="sp-waiting" data-testid="sp-wait-question">
        {peerName} is {isCustomRound(round) ? "writing their own question" : "choosing the next question"}
        <Dots />
      </p>
      <p className="sp-sub">You'll both answer it privately.</p>
    </div>
  );
}

function QuestionBox({ s }: { s: State }) {
  const cat = s.question ? categoryOf(s.question.category) : undefined;
  return (
    <div className="sp-question" data-testid="sp-question">
      <div className="sp-eyebrow">
        {isCustomRound(s.round) ? `Custom question ${s.round - REGULAR_ROUNDS} of ${CUSTOM_ROUNDS}` : `Round ${pad2(s.round)}`}
        {cat ? ` · ${cat.emoji} ${cat.label}` : ""}
      </div>
      <div className="sp-question-text">“{s.question?.text}”</div>
    </div>
  );
}

function Answer({ s, iAsked, peerName, onSubmit }: { s: State; iAsked: boolean; peerName: string; onSubmit: (t: string) => void }) {
  const [text, setText] = useState("");
  const clean = cleanText(text);
  const valid = isValidAnswer(clean);

  if (!canAnswer(s) && s.myAnswer !== null) {
    // Locked in. Only OUR answer is shown – the peer's answer (even if it has
    // already arrived) stays hidden until the reveal.
    return (
      <div className="sp-col sp-fill">
        <QuestionBox s={s} />
        <div className="sp-locked sp-center sp-col">
          <div className="sp-h2 sp-success">Your answer is locked in! 💗</div>
          <p className="sp-waiting" data-testid="sp-wait-answer">
            Waiting for {peerName}
            <Dots />
          </p>
          <div className="sp-mine" aria-label="Your answer">
            <span className="sp-label">You said</span>
            <span className="sp-mine-text">{s.myAnswer}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sp-col sp-fill">
      <p className="sp-lead">{iAsked ? "You asked – now answer it too!" : `${peerName} has a question for you!`}</p>
      <QuestionBox s={s} />
      <label className="sp-label" htmlFor={`sp-answer-${s.role}`}>
        Your Answer
      </label>
      <LimitedTextarea
        id={`sp-answer-${s.role}`}
        value={text}
        onChange={setText}
        maxBytes={ANSWER_MAX_BYTES}
        placeholder="Type your answer here..."
        label="Your answer"
      />
      <button type="button" className="sp-btn" onClick={() => valid && onSubmit(clean)} disabled={!valid}>
        Submit Answer
      </button>
    </div>
  );
}

function Reveal({ s, role, peerName, onNext }: { s: State; role: Player; peerName: string; onNext: () => void }) {
  const peer: Player = role === "host" ? "guest" : "host";
  const nextLabel =
    s.round === TOTAL_ROUNDS ? "Finish 💗" : s.round === REGULAR_ROUNDS ? "Next: custom questions 💬" : "Next question →";
  return (
    <div className="sp-col sp-fill sp-reveal">
      <div className="sp-h2">Let's see what you both said! ✨</div>
      <div className="sp-reveal-q">“{s.question?.text}”</div>
      <div className="sp-answers">
        <div className={`sp-answer ${pc(role)}`} data-testid="sp-answer-mine">
          <div className="sp-answer-label">Your answer</div>
          <div className="sp-answer-text">{s.myAnswer}</div>
        </div>
        <div className={`sp-answer ${pc(peer)}`} data-testid="sp-answer-peer">
          <div className="sp-answer-label">{peerName}'s answer</div>
          <div className="sp-answer-text">{s.peerAnswer}</div>
        </div>
      </div>
      <button type="button" className="sp-btn" onClick={onNext}>
        {nextLabel}
      </button>
    </div>
  );
}

function Done({ s, peerName, onRematch, onBack }: { s: State; peerName: string; onRematch: () => void; onBack: () => void }) {
  return (
    <div className="sp-col sp-center sp-fill">
      <div className="sp-title">That was fun! 💗</div>
      <p className="sp-sub">{TOTAL_ROUNDS} questions, interesting conversations and two people getting to know each other.</p>
      <div className="sp-chips">
        <span className="sp-chip sp-chip-ok">✓ {REGULAR_ROUNDS} regular rounds completed</span>
        <span className="sp-chip sp-chip-ok">✓ {CUSTOM_ROUNDS} custom questions completed</span>
      </div>
      <button type="button" className="sp-btn" onClick={onRematch} disabled={s.myRematch}>
        {s.myRematch ? "Waiting…" : s.peerRematch ? "Accept & play again" : "Play Again"}
      </button>
      <p className="sp-sub" data-testid="sp-rematch-status">
        {s.myRematch
          ? `Waiting for ${peerName} to agree…`
          : s.peerRematch
            ? `${peerName} wants to play again!`
            : s.firstAsker !== s.role
              ? "You ask first next game"
              : `${peerName} asks first next game`}
      </p>
      <button type="button" className="sp-btn-ghost" onClick={onBack}>
        Back
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function LimitedTextarea(props: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  maxBytes: number;
  placeholder: string;
  label: string;
}) {
  const used = useMemo(() => jsonBytes(cleanText(props.value)) - 2, [props.value]);
  const left = props.maxBytes - 2 - used;
  return (
    <div className="sp-textarea-wrap">
      <textarea
        id={props.id}
        className="sp-textarea"
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.label}
        rows={3}
        onChange={(e) => {
          const v = e.target.value;
          // Never let the text grow past the wire limit (keeps messages < 512 B).
          if (jsonBytes(cleanText(v)) <= props.maxBytes || v.length < props.value.length) props.onChange(v);
        }}
      />
      <span className={`sp-counter ${left < 20 ? "sp-warn" : ""}`} aria-hidden="true">
        {Math.max(0, left)}
      </span>
    </div>
  );
}

function Dots() {
  return (
    <span className="sp-dots" aria-hidden="true">
      <i>.</i>
      <i>.</i>
      <i>.</i>
    </span>
  );
}
