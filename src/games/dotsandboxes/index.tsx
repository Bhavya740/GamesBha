import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import "./styles.css";
import { DEFAULT_GEOMETRY, edgeCoords, playerOf, type Owner, type Player } from "./logic";
import {
  MAX_MESSAGE_BYTES,
  canMove,
  createSession,
  localLeave,
  localMove,
  localRematch,
  messageBytes,
  receive,
  startMessage,
  type Session,
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
// Board drawing constants (SVG user units; the SVG scales to fit the panel)
// ---------------------------------------------------------------------------

const GEO = DEFAULT_GEOMETRY;
const S = 40; // distance between dots
const P = 22; // padding around the outer dots (room for the outer touch targets)
const VIEW_W = GEO.cols * S + 2 * P;
const VIEW_H = GEO.rows * S + 2 * P;
const DOT_R = 4.2;
/** Minimum time between two local taps that send a move (keeps us far below 10 msg/s). */
const TAP_COOLDOWN_MS = 120;

const px = (gridX: number) => P + gridX * S;

interface EdgeShape {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Diamond-shaped touch target; the diamonds tile the board so every tap hits exactly one line. */
  hit: string;
  label: string;
}

const EDGE_SHAPES: EdgeShape[] = Array.from({ length: GEO.edgeCount }, (_, e) => {
  const c = edgeCoords(GEO, e);
  const x1 = px(c.x1);
  const y1 = px(c.y1);
  const x2 = px(c.x2);
  const y2 = px(c.y2);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const h = S / 2;
  const hit =
    c.dir === "h"
      ? `${x1},${y1} ${mx},${my - h} ${x2},${y2} ${mx},${my + h}`
      : `${x1},${y1} ${mx + h},${my} ${x2},${y2} ${mx - h},${my}`;
  const label =
    c.dir === "h"
      ? `Horizontal line, row ${c.y1 + 1}, between columns ${c.x1 + 1} and ${c.x2 + 1}`
      : `Vertical line, column ${c.x1 + 1}, between rows ${c.y1 + 1} and ${c.y2 + 1}`;
  return { x1, y1, x2, y2, hit, label };
});

const DOTS: { x: number; y: number }[] = [];
for (let r = 0; r <= GEO.rows; r++) for (let c = 0; c <= GEO.cols; c++) DOTS.push({ x: px(c), y: px(r) });

const colorClass = (o: Owner | Player | null) =>
  o === 1 || o === "host" ? "dnb-host" : o === 2 || o === "guest" ? "dnb-guest" : "";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Game(props: GameProps): React.JSX.Element {
  const { role, onMessage, onExit } = props;
  const myName = props.myName.trim() || "You";
  const peerName = props.peerName.trim() || "Opponent";
  const peerRole: Player = role === "host" ? "guest" : "host";

  const [session, setSession] = useState<Session>(() => createSession(role, GEO));
  const sessionRef = useRef(session);
  const sendRef = useRef(props.send);
  const lastTapRef = useRef(0);

  useLayoutEffect(() => {
    sendRef.current = props.send;
  });

  const safeSend = useCallback((msg: GameMessage) => {
    const bytes = messageBytes(msg);
    if (bytes >= MAX_MESSAGE_BYTES) {
      console.warn(`[dotsandboxes] dropped oversize message (${bytes} B)`, msg.action);
      return;
    }
    try {
      sendRef.current(msg);
    } catch (err) {
      console.warn("[dotsandboxes] send failed", err);
    }
  }, []);

  const commit = useCallback(
    (step: Step) => {
      if (step.session !== sessionRef.current) {
        sessionRef.current = step.session;
        setSession(step.session);
      }
      step.out.forEach(safeSend);
    },
    [safeSend],
  );

  // Subscribe to the peer's messages; the returned unsubscribe runs on unmount.
  useEffect(() => {
    const unsubscribe = onMessage((msg) => commit(receive(sessionRef.current, msg)));
    return () => {
      unsubscribe();
    };
  }, [onMessage, commit]);

  // Say hello once on mount. The peer answers with its state, which lets a
  // late / re-opened copy of the game catch up.
  useEffect(() => {
    safeSend(startMessage(sessionRef.current));
  }, [safeSend]);

  const tapEdge = (edge: number) => {
    const now = Date.now();
    if (now - lastTapRef.current < TAP_COOLDOWN_MS) return;
    const step = localMove(sessionRef.current, edge);
    if (step.out.length) lastTapRef.current = now;
    commit(step);
  };

  const onEdgeKey = (e: KeyboardEvent, edge: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      tapEdge(edge);
    }
  };

  const playAgain = () => commit(localRematch(sessionRef.current));

  const back = () => {
    commit(localLeave(sessionRef.current));
    onExit();
  };

  // ----- derived view state -----
  const { board, peerLeft, myRematch, peerRematch } = session;
  const myTurn = canMove(session);
  const nameOf = (p: Player) => (p === role ? myName : peerName);
  const myScore = board.scores[role];
  const peerScore = board.scores[peerRole];
  const extraTurn = board.lastCompleted.length > 0 && !board.over;

  let status: string;
  let statusTone: "me" | "peer" | "success" | "warning" | "muted";
  if (peerLeft) {
    status = `${peerName} left the game`;
    statusTone = "warning";
  } else if (board.over) {
    if (board.winner === "draw") {
      status = "It's a draw!";
      statusTone = "warning";
    } else if (board.winner === role) {
      status = "You win! 🎉";
      statusTone = "success";
    } else {
      status = `${peerName} wins`;
      statusTone = "muted";
    }
  } else if (myTurn) {
    status = extraTurn ? "Box! Go again" : "Your turn";
    statusTone = "me";
  } else {
    status = extraTurn ? `${peerName} goes again` : `${peerName}'s turn`;
    statusTone = "peer";
  }

  const rootClass = [
    "dnb-root",
    role === "host" ? "dnb-me-host" : "dnb-me-guest",
    myTurn ? "dnb-myturn" : "",
  ].join(" ");

  return (
    <div className={rootClass} data-role={role}>
      {/* Header: Back · status · round */}
      <div className="dnb-header">
        <button type="button" className="dnb-back" onClick={back} aria-label="Back">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className={`dnb-status dnb-tone-${statusTone}`} role="status" aria-live="polite" data-testid="dnb-status">
          {status}
        </div>
        <div className="dnb-round" aria-label={`Round ${board.round}`}>
          R{board.round}
        </div>
      </div>

      {/* Scores: You vs peer */}
      <div className="dnb-scores">
        <ScoreCard
          player={role}
          name={myName}
          tag="You"
          score={myScore}
          active={!board.over && !peerLeft && board.turn === role}
        />
        <div className="dnb-vs" aria-hidden="true">
          vs
        </div>
        <ScoreCard
          player={peerRole}
          name={peerName}
          tag="Opponent"
          score={peerScore}
          active={!board.over && !peerLeft && board.turn === peerRole}
        />
      </div>

      {/* Board */}
      <div className="dnb-board-wrap">
        <svg
          className="dnb-board"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="group"
          aria-label={`Dots and Boxes board, ${GEO.rows} by ${GEO.cols} boxes`}
        >
          <rect className="dnb-board-bg" x={2} y={2} width={VIEW_W - 4} height={VIEW_H - 4} rx={18} />

          {/* Completed boxes */}
          {board.boxes.map((o, b) => {
            if (!o) return null;
            const x = px(b % GEO.cols);
            const y = px(Math.floor(b / GEO.cols));
            const owner = playerOf(o)!;
            return (
              <g key={`b${b}`} className={`dnb-box ${colorClass(o)}`} data-box={b} data-owner={owner}>
                <rect x={x + 3} y={y + 3} width={S - 6} height={S - 6} rx={6} />
                <text x={x + S / 2} y={y + S / 2} dominantBaseline="central" textAnchor="middle">
                  {nameOf(owner).charAt(0).toUpperCase()}
                </text>
              </g>
            );
          })}

          {/* Empty line guides */}
          {EDGE_SHAPES.map((s, e) =>
            board.edges[e] ? null : (
              <line key={`g${e}`} className="dnb-guide" x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />
            ),
          )}

          {/* Drawn lines */}
          {EDGE_SHAPES.map((s, e) => {
            const o = board.edges[e];
            if (!o) return null;
            const last = board.lastEdge === e;
            return (
              <g key={`l${e}`} className={`dnb-line ${colorClass(o)} ${last ? "dnb-last" : ""}`} data-line={e}>
                {last && <line className="dnb-line-glow" x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />}
                <line className="dnb-line-stroke" x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} pathLength={1} />
              </g>
            );
          })}

          {/* Dots */}
          {DOTS.map((d, i) => (
            <circle key={`d${i}`} className="dnb-dot" cx={d.x} cy={d.y} r={DOT_R} />
          ))}

          {/* Touch targets for open lines */}
          {EDGE_SHAPES.map((s, e) =>
            board.edges[e] ? null : (
              <g
                key={`h${e}`}
                className="dnb-hit"
                data-edge={e}
                role="button"
                aria-label={s.label}
                aria-disabled={!myTurn}
                tabIndex={myTurn ? 0 : -1}
                onClick={() => tapEdge(e)}
                onKeyDown={(ev) => onEdgeKey(ev, e)}
              >
                <polygon points={s.hit} />
                <line className="dnb-preview" x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />
              </g>
            ),
          )}
        </svg>

        {(board.over || peerLeft) && (
          <div className="dnb-overlay" data-testid="dnb-overlay">
            <div className="dnb-card">
              {peerLeft ? (
                <>
                  <div className="dnb-card-title dnb-tone-warning">{peerName} left</div>
                  <div className="dnb-card-sub">
                    Final score {myScore} – {peerScore}
                  </div>
                  <button type="button" className="dnb-btn" onClick={back}>
                    Back
                  </button>
                </>
              ) : (
                <>
                  <div className={`dnb-card-title dnb-tone-${statusTone}`}>{status}</div>
                  <div className="dnb-card-score">
                    <span className={colorClass(role)}>{myScore}</span>
                    <span className="dnb-dash">–</span>
                    <span className={colorClass(peerRole)}>{peerScore}</span>
                  </div>
                  <button type="button" className="dnb-btn" onClick={playAgain} disabled={myRematch}>
                    {myRematch ? "Waiting…" : peerRematch ? "Accept rematch" : "Play again"}
                  </button>
                  <div className="dnb-card-sub" data-testid="dnb-rematch-status">
                    {myRematch
                      ? `Waiting for ${peerName} to accept`
                      : peerRematch
                        ? `${peerName} wants a rematch!`
                        : `${nameOf(board.round % 2 === 1 ? "guest" : "host")} starts next round`}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreCard(props: { player: Player; name: string; tag: string; score: number; active: boolean }) {
  const { player, name, tag, score, active } = props;
  return (
    <div className={`dnb-score ${colorClass(player)} ${active ? "dnb-active" : ""}`} data-player={player}>
      <div className="dnb-score-text">
        <span className="dnb-score-name">{name}</span>
        <span className="dnb-score-tag">
          {active && <i className="dnb-turn-dot" aria-hidden="true" />}
          {active ? (tag === "You" ? "You · turn" : "Their turn") : tag}
        </span>
      </div>
      <span key={score} className="dnb-score-num" data-testid={`dnb-score-${player}`}>
        {score}
      </span>
    </div>
  );
}
