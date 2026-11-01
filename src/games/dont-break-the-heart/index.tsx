import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import "./styles.css";
import { CENTER, HEART_CRACKS, HEART_PATH, PIECES, VIEW_H, VIEW_W } from "./heart";
import { MAX_CRACKS, PIECE_COUNT, generateFragile, starterForRound, type Player } from "./logic";
import {
  MAX_MESSAGE_BYTES,
  canTap,
  createState,
  guestResync,
  localLeave,
  localRematch,
  localTap,
  messageBytes,
  mountMessage,
  receive,
  scoresOf,
  type HostEnv,
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

/**
 * Host-only randomness. The guest never generates anything: it receives the
 * fragile positions from the host. Game ids grow over time so a re-opened
 * host's new game is recognisably newer than the old one.
 */
const HOST_ENV: HostEnv = {
  newGameId: () => Date.now() * 1000 + Math.floor(Math.random() * 1000),
  newFragile: () => generateFragile(),
};

/** If the host hasn't confirmed a guest move within this time, the guest resyncs. */
const GUEST_PENDING_TIMEOUT_MS = 3000;

const AVATAR: Record<Player, string> = { host: "🐰", guest: "🐻" };

export default function Game(props: GameProps): React.JSX.Element {
  const { role, onMessage, onExit } = props;
  const myName = props.myName.trim() || "You";
  const peerName = props.peerName.trim() || "your partner";
  const env = role === "host" ? HOST_ENV : undefined;

  const [state, setState] = useState<State>(() => createState(role, env));
  const [showHelp, setShowHelp] = useState(false);
  const stateRef = useRef(state);
  const sendRef = useRef(props.send);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");

  useLayoutEffect(() => {
    sendRef.current = props.send;
  });

  const safeSend = useCallback((msg: GameMessage) => {
    const bytes = messageBytes(msg);
    if (bytes >= MAX_MESSAGE_BYTES) {
      console.warn(`[heartfall] dropped oversize message (${bytes} B)`, msg.action);
      return;
    }
    try {
      sendRef.current(msg);
    } catch (err) {
      console.warn("[heartfall] send failed", err);
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

  useEffect(() => {
    const unsubscribe = onMessage((msg) => commit(receive(stateRef.current, msg, env)));
    return () => {
      unsubscribe();
    };
  }, [onMessage, commit, env]);

  // Host: publish the configuration. Guest: say hello and ask for it.
  useEffect(() => {
    safeSend(mountMessage(stateRef.current));
  }, [safeSend]);

  // Guest safety net: a request the host never answered must not freeze the board.
  useEffect(() => {
    if (state.pending === null) return;
    const piece = state.pending;
    const t = setTimeout(() => {
      if (stateRef.current.pending === piece) commit(guestResync(stateRef.current));
    }, GUEST_PENDING_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [state.pending, commit]);

  const tap = (piece: number) => commit(localTap(stateRef.current, piece));
  const onKey = (e: KeyboardEvent, piece: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      tap(piece);
    }
  };
  const playAgain = () => commit(localRematch(stateRef.current, env));
  const exit = () => {
    commit(localLeave(stateRef.current));
    onExit();
  };

  // ----- derived view -----
  const s = state;
  const board = s.board;
  const cfg = s.cfg;
  const scores = scoresOf(s);
  const nameOf = (p: Player) => (p === role ? myName : peerName);
  const myTurn = canTap(s);
  const cracks = board?.cracks ?? 0;
  const result = board?.result ?? null;
  const shattered = result?.kind === "break";
  const playing = !!board && !board.over && !s.peerLeft;

  let turnText: string;
  let turnTone = "";
  if (s.peerLeft) {
    turnText = "Your partner left the game.";
    turnTone = "hf-tone-warn";
  } else if (!cfg || !board) {
    turnText = `Waiting for ${peerName} to set up the heart…`;
  } else if (role === "host" && !s.peerPresent && !board.over) {
    turnText = "Waiting for the other player...";
  } else if (result?.kind === "break") {
    turnText = result.loser === role ? "You broke the heart 💔" : `${peerName} broke the heart 💔`;
    turnTone = result.loser === role ? "hf-tone-warn" : "hf-tone-ok";
  } else if (result?.kind === "draw") {
    turnText = "The heart survived! 💗";
    turnTone = "hf-tone-ok";
  } else if (s.pending !== null) {
    turnText = "Placing your move…";
  } else if (myTurn) {
    turnText = "Your Turn 💗";
    turnTone = "hf-tone-me";
  } else {
    turnText = `Waiting for ${peerName}...`;
  }

  const heartClass = ["hf-heart", cracks >= 1 && !shattered ? `hf-shake-${Math.min(cracks, 2)}` : "", shattered ? "hf-shatter" : ""].join(" ");

  return (
    <div className={`hf-root ${role === "host" ? "hf-me-host" : "hf-me-guest"}`} data-role={role}>
      {/* A. Header */}
      <header className="hf-header">
        <span className="hf-rose" aria-hidden="true">
          🌹
        </span>
        <div className="hf-heading">
          <div className="hf-title">Heartfall 💗</div>
          <div className="hf-subtitle">Take turns removing glass pieces. Don't break the heart!</div>
        </div>
      </header>

      {/* B. Players */}
      <div className="hf-players">
        <PlayerCard p="host" name={nameOf("host")} me={role === "host"} score={scores.host} active={playing && board.turn === "host"} />
        <div className="hf-round" data-testid="hf-round">
          R{cfg?.round ?? 1}
        </div>
        <PlayerCard p="guest" name={nameOf("guest")} me={role === "guest"} score={scores.guest} active={playing && board.turn === "guest"} />
      </div>

      {/* E. Turn indicator */}
      <div className={`hf-turn ${turnTone}`} key={turnText} role="status" aria-live="polite" data-testid="hf-turn">
        {turnText}
      </div>

      {/* C. Heart */}
      <div className="hf-board">
        <span className="hf-deco hf-deco-1" aria-hidden="true">✧</span>
        <span className="hf-deco hf-deco-2" aria-hidden="true">♥</span>
        <span className="hf-deco hf-deco-3" aria-hidden="true">✦</span>
        <span className="hf-deco hf-deco-4" aria-hidden="true">♡</span>

        <svg
          className={heartClass}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="group"
          aria-label={`Glass heart, ${board?.remaining ?? PIECE_COUNT} pieces left, ${cracks} of ${MAX_CRACKS} cracks`}
        >
          <defs>
            <clipPath id={`hf-clip-${uid}`}>
              <path d={HEART_PATH} />
            </clipPath>
            <linearGradient id={`hf-g0-${uid}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#ffe4ef" stopOpacity="0.95" />
              <stop offset="0.55" stopColor="#ff9cc2" stopOpacity="0.78" />
              <stop offset="1" stopColor="#ff4f8b" stopOpacity="0.72" />
            </linearGradient>
            <linearGradient id={`hf-g1-${uid}`} x1="1" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffd6e7" stopOpacity="0.92" />
              <stop offset="0.6" stopColor="#ff86b3" stopOpacity="0.76" />
              <stop offset="1" stopColor="#e9407e" stopOpacity="0.75" />
            </linearGradient>
            <linearGradient id={`hf-g2-${uid}`} x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#ff6fa3" stopOpacity="0.8" />
              <stop offset="0.5" stopColor="#ffb3d1" stopOpacity="0.8" />
              <stop offset="1" stopColor="#fff0f6" stopOpacity="0.92" />
            </linearGradient>
            <linearGradient id={`hf-shine-${uid}`} x1="0" y1="0" x2="0.6" y2="1">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
              <stop offset="0.35" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* soft glow behind the glass */}
          <path className="hf-glow" d={HEART_PATH} />

          {PIECES.map((pc, i) => {
            const used = board?.used[i] ?? false;
            const cracked = board?.crackedPieces.includes(i) ?? false;
            const status = !used ? "intact" : cracked ? "cracked" : "gone";
            const isLast = board?.lastPiece === i;
            const cls = [
              "hf-piece",
              `hf-p-${status}`,
              status === "gone" && isLast ? "hf-gone-now" : "",
              status === "cracked" && isLast ? "hf-crack-now" : "",
              s.pending === i ? "hf-pending" : "",
              shattered && status !== "gone" ? "hf-fly" : "",
            ].join(" ");
            const style = { "--dx": `${pc.dx}px`, "--dy": `${pc.dy}px`, "--rot": `${pc.rot}deg`, "--d": `${(i % 4) * 40}ms` } as CSSProperties;
            return (
              <g key={i} className={cls} style={style} data-piece={i} data-status={status}>
                <g clipPath={`url(#hf-clip-${uid})`}>
                  <polygon className="hf-glass" points={pc.points} fill={`url(#hf-g${i % 3}-${uid})`} />
                  <polygon className="hf-shine" points={pc.points} fill={`url(#hf-shine-${uid})`} />
                </g>
                {status === "cracked" && <path className="hf-piece-crack" d={pc.crack} />}
              </g>
            );
          })}

          {/* heart outline */}
          <path className="hf-outline" d={HEART_PATH} />

          {/* cracks across the heart */}
          {HEART_CRACKS.slice(0, Math.min(cracks, 2)).map((d, k) => (
            <path key={k} className={`hf-heart-crack hf-heart-crack-${k + 1}`} d={d} pathLength={1} />
          ))}

          {/* effects for the latest move (keyed so they play once per move) */}
          {board && board.lastPiece !== null && (
            <g key={`fx-${cfg!.round}-${board.used.filter(Boolean).length}`} className="hf-fx" aria-hidden="true">
              {board.lastWasFragile
                ? Array.from({ length: 8 }, (_, k) => {
                    const a = (k / 8) * Math.PI * 2;
                    const st = { "--tx": `${Math.cos(a) * 22}px`, "--ty": `${Math.sin(a) * 22}px` } as CSSProperties;
                    return <circle key={k} className="hf-particle" cx={PIECES[board.lastPiece!].cx} cy={PIECES[board.lastPiece!].cy} r={2.4} style={st} />;
                  })
                : [0, 1, 2, 3].map((k) => {
                    const st = { "--tx": `${[-14, 12, -8, 14][k]}px`, "--ty": `${[-12, -10, 12, 9][k]}px` } as CSSProperties;
                    return (
                      <text key={k} className="hf-sparkle" x={PIECES[board.lastPiece!].cx} y={PIECES[board.lastPiece!].cy} style={st}>
                        ✦
                      </text>
                    );
                  })}
            </g>
          )}

          {/* shatter shards */}
          {shattered && (
            <g className="hf-shards" aria-hidden="true">
              {Array.from({ length: 10 }, (_, k) => {
                const a = (k / 10) * Math.PI * 2 + 0.3;
                const st = { "--tx": `${Math.cos(a) * 90}px`, "--ty": `${Math.sin(a) * 80}px`, "--rot": `${k * 47}deg` } as CSSProperties;
                return (
                  <polygon key={k} className="hf-shard" points={`${CENTER.x},${CENTER.y - 6} ${CENTER.x + 6},${CENTER.y + 4} ${CENTER.x - 5},${CENTER.y + 5}`} style={st} />
                );
              })}
            </g>
          )}

          {/* touch targets (one button per available piece) */}
          {PIECES.map((pc, i) =>
            board && !board.used[i] && !shattered ? (
              <polygon
                key={`hit-${i}`}
                className={`hf-hit ${myTurn ? "hf-hit-on" : ""}`}
                points={pc.hit}
                role="button"
                tabIndex={myTurn ? 0 : -1}
                aria-label={`Glass piece ${i + 1}`}
                aria-disabled={!myTurn}
                data-hit={i}
                onClick={() => tap(i)}
                onKeyDown={(e) => onKey(e, i)}
              />
            ) : null,
          )}
        </svg>

        {board?.over && !s.peerLeft && (
          <ResultCard
            s={s}
            role={role}
            nameOf={nameOf}
            peerName={peerName}
            scores={scores}
            onPlayAgain={playAgain}
            onExit={exit}
          />
        )}

        {s.peerLeft && (
          <div className="hf-overlay" data-testid="hf-left">
            <div className="hf-card">
              <div className="hf-card-emoji" aria-hidden="true">
                🥀
              </div>
              <div className="hf-card-title hf-tone-warn">Your partner left the game.</div>
              <div className="hf-card-sub">
                Final score {nameOf("host")} {scores.host} – {scores.guest} {nameOf("guest")}
              </div>
              <button type="button" className="hf-btn" onClick={exit}>
                Exit
              </button>
            </div>
          </div>
        )}
      </div>

      {/* D + F. Crack indicator and controls */}
      <div className="hf-bottom">
        <button type="button" className="hf-ghost" onClick={() => setShowHelp(true)}>
          How to Play?
        </button>
        <div className="hf-strength" aria-label={`Heart strength ${MAX_CRACKS - cracks} of ${MAX_CRACKS}`} data-testid="hf-strength">
          <div className="hf-hearts" aria-hidden="true">
            {Array.from({ length: MAX_CRACKS }, (_, k) => (
              <span key={k} className={k < cracks ? "hf-h-broken" : "hf-h-ok"}>
                {k < cracks ? "💔" : "♥"}
              </span>
            ))}
          </div>
          <div className="hf-strength-text">
            Heart strength: {MAX_CRACKS - cracks}/{MAX_CRACKS}
          </div>
        </div>
        <button type="button" className="hf-ghost" onClick={exit}>
          Exit
        </button>
      </div>

      {showHelp && <HowToPlay onClose={() => setShowHelp(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PlayerCard({ p, name, me, score, active }: { p: Player; name: string; me: boolean; score: number; active: boolean }) {
  return (
    <div className={`hf-player hf-${p} ${active ? "hf-active" : ""}`} data-player={p}>
      <span className="hf-avatar" aria-hidden="true">
        {AVATAR[p]}
      </span>
      <div className="hf-player-text">
        <span className="hf-player-name">{name}</span>
        <span className="hf-player-tag">
          {p === "host" ? "Host" : "Guest"}
          {me ? " · You" : ""}
        </span>
      </div>
      <span key={score} className="hf-score" data-testid={`hf-score-${p}`}>
        {score}
      </span>
    </div>
  );
}

function ResultCard(props: {
  s: State;
  role: Player;
  nameOf: (p: Player) => string;
  peerName: string;
  scores: { host: number; guest: number };
  onPlayAgain: () => void;
  onExit: () => void;
}) {
  const { s, role, nameOf, peerName, scores, onPlayAgain, onExit } = props;
  const result = s.board!.result!;
  const broke = result.kind === "break";
  const iLost = broke && result.loser === role;
  const nextStarter = starterForRound(s.cfg!.round + 1);

  let title: string;
  if (!broke) title = "Both of you saved the heart! 💗";
  else if (iLost) title = "Oops! You broke the heart! 💔";
  else title = `${peerName} broke the heart! You win 💗`;

  return (
    <div className={`hf-overlay hf-result ${broke ? "hf-result-late" : ""}`} data-testid="hf-result">
      <Celebration />
      <div className="hf-card">
        <div className={`hf-card-title ${iLost ? "hf-tone-warn" : "hf-tone-ok"}`} data-testid="hf-result-title">
          {title}
        </div>
        <div className="hf-card-sub" data-testid="hf-result-names">
          {broke ? (
            <>
              Winner: <b className={`hf-c-${result.winner}`}>{nameOf(result.winner)}</b> · Broke it:{" "}
              <b className={`hf-c-${result.loser}`}>{nameOf(result.loser)}</b>
            </>
          ) : (
            "It's a draw – nobody scores."
          )}
        </div>
        <div className="hf-final" data-testid="hf-final">
          <span className="hf-c-host">{scores.host}</span>
          <span className="hf-dash">–</span>
          <span className="hf-c-guest">{scores.guest}</span>
        </div>
        <div className="hf-actions">
          <button type="button" className="hf-btn" onClick={onPlayAgain} disabled={s.myRematch}>
            {s.myRematch ? "Waiting…" : s.peerRematch ? "Accept & Play" : "Play Again"}
          </button>
          <button type="button" className="hf-ghost" onClick={onExit}>
            Exit
          </button>
        </div>
        <div className="hf-card-sub" data-testid="hf-rematch-status">
          {s.myRematch
            ? `Waiting for ${peerName} to agree…`
            : s.peerRematch
              ? `${peerName} wants to play again!`
              : `${nextStarter === role ? "You go" : `${nameOf(nextStarter)} goes`} first next round`}
        </div>
      </div>
    </div>
  );
}

const CONFETTI = Array.from({ length: 14 }, (_, k) => ({
  left: `${(k * 37) % 100}%`,
  delay: `${(k % 7) * 0.22}s`,
  dur: `${2.6 + (k % 4) * 0.45}s`,
  glyph: ["💗", "🌸", "✦", "💕", "🌹", "✧", "💖"][k % 7],
}));

function Celebration() {
  return (
    <div className="hf-confetti" aria-hidden="true">
      {CONFETTI.map((c, k) => (
        <span key={k} style={{ left: c.left, animationDelay: c.delay, animationDuration: c.dur }}>
          {c.glyph}
        </span>
      ))}
    </div>
  );
}

function HowToPlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="hf-help" role="dialog" aria-modal="true" aria-label="How to play" data-testid="hf-help">
      <div className="hf-help-card">
        <div className="hf-card-title">How to Play 💗</div>
        <ul>
          <li>Take turns tapping one glass piece of the heart.</li>
          <li>9 pieces are safe and simply disappear.</li>
          <li>3 hidden pieces are fragile and crack the heart.</li>
          <li>The heart survives 2 cracks. Whoever causes the 3rd crack breaks it and loses.</li>
          <li>Winner gets 1 point. The first player swaps every round.</li>
        </ul>
        <button type="button" className="hf-btn" onClick={onClose}>
          Got it!
        </button>
      </div>
    </div>
  );
}

