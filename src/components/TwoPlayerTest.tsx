/**
 * LOCAL DEVELOPMENT ONLY – not part of the game folder.
 *
 * Renders two copies of a Gulaab game side by side (host left, guest right)
 * and wires them together with an in-memory bridge that has exactly the same
 * shape as Gulaab's real connection: `send` + `onMessage` (returns unsubscribe).
 * Each message is JSON round-tripped and delivered after a 150 ms delay,
 * as in the Gulaab developer brief.
 */
import { useRef, useState, type ComponentType } from "react";
import type { GameMessage, GameProps } from "../games/dotsandboxes";

type Side = "host" | "guest";
type Handler = (m: GameMessage) => void;

export const BRIDGE_DELAY_MS = 150;

interface LogEntry {
  id: number;
  from: Side;
  text: string;
  bytes: number;
}

const NAMES: Record<Side, string> = { host: "Priya", guest: "Arjun" };
const otherSide = (s: Side): Side => (s === "host" ? "guest" : "host");

export default function TwoPlayerTest({ Game }: { Game: ComponentType<GameProps> }) {
  // Stable for the lifetime of the test page (never recreated on re-render).
  const subs = useRef<Record<Side, Set<Handler>>>({ host: new Set(), guest: new Set() }).current;
  const optsRef = useRef({ duplicate: false });
  const logId = useRef(0);

  const [keys, setKeys] = useState<Record<Side, number>>({ host: 0, guest: 0 });
  const [exited, setExited] = useState<Record<Side, boolean>>({ host: false, guest: false });
  const [width, setWidth] = useState<384 | 320>(384);
  const [duplicate, setDuplicate] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  const deliver = (to: Side, payload: unknown) => {
    setTimeout(() => subs[to].forEach((h) => h(JSON.parse(JSON.stringify(payload)))), BRIDGE_DELAY_MS);
  };

  // Built once so `send` / `onMessage` keep a stable identity, like a real host app would.
  const propsRef = useRef<Record<Side, GameProps> | null>(null);
  if (!propsRef.current) {
    const mk = (me: Side): GameProps => ({
      role: me,
      myName: NAMES[me],
      peerName: NAMES[otherSide(me)],
      send: (m) => {
        const text = JSON.stringify(m);
        const entry: LogEntry = { id: ++logId.current, from: me, text, bytes: new TextEncoder().encode(text).length };
        setLog((l) => [entry, ...l].slice(0, 40));
        deliver(otherSide(me), m);
        if (optsRef.current.duplicate) deliver(otherSide(me), m);
      },
      onMessage: (h) => {
        subs[me].add(h);
        return () => {
          subs[me].delete(h);
        };
      },
      onExit: () => setExited((e) => ({ ...e, [me]: true })),
    });
    propsRef.current = { host: mk("host"), guest: mk("guest") };
  }
  const gameProps = propsRef.current;

  const reopen = (side: Side) => {
    setExited((e) => ({ ...e, [side]: false }));
    setKeys((k) => ({ ...k, [side]: k[side] + 1 }));
  };

  const resetBoth = () => {
    setExited({ host: false, guest: false });
    setKeys((k) => ({ host: k.host + 1, guest: k.guest + 1 }));
    setLog([]);
  };

  const injectGarbage = () => {
    const bad: unknown[] = [
      null,
      "hello",
      [1, 2, 3],
      { action: "move" },
      { action: "move", round: 1, n: 0, edge: 999 },
      { action: "move", round: 1, n: -1, edge: 3 },
      { action: "move", round: 1, n: 0, edge: 2.5 },
      { action: "move", round: "1", n: 0, edge: 3 },
      { action: "start", round: 1, moves: "nope", reply: false },
      { action: "rematch", round: 0 },
      { action: "explode" },
    ];
    for (const side of ["host", "guest"] as Side[]) bad.forEach((m) => deliver(side, m));
    const entry: LogEntry = { id: ++logId.current, from: "host", text: `⚠ injected ${bad.length} invalid messages into both sides`, bytes: 0 };
    setLog((l) => [entry, ...l].slice(0, 40));
  };

  const panel = (side: Side) => (
    <div className="tpt-col">
      <div className="tpt-label">
        <span className={`tpt-chip tpt-${side}`}>{side === "host" ? "HOST" : "GUEST"}</span>
        {NAMES[side]}
      </div>
      <div className="tpt-phone" style={{ width }}>
        {exited[side] ? (
          <div className="tpt-exited">
            <p>{NAMES[side]} tapped Back (onExit called).</p>
            <button type="button" className="tpt-btn" onClick={() => reopen(side)}>
              Re-open game
            </button>
          </div>
        ) : (
          <Game key={keys[side]} {...gameProps[side]} />
        )}
      </div>
    </div>
  );

  return (
    <div className="tpt">
      <div className="tpt-toolbar">
        <button type="button" className="tpt-btn" onClick={resetBoth}>
          Reset both
        </button>
        <button type="button" className="tpt-btn" onClick={() => setWidth((w) => (w === 384 ? 320 : 384))}>
          Width: {width}px
        </button>
        <label className="tpt-check">
          <input
            type="checkbox"
            checked={duplicate}
            onChange={(e) => {
              optsRef.current.duplicate = e.target.checked;
              setDuplicate(e.target.checked);
            }}
          />
          Duplicate every message
        </label>
        <button type="button" className="tpt-btn" onClick={injectGarbage}>
          Inject invalid messages
        </button>
        <span className="tpt-note">Bridge delay: {BRIDGE_DELAY_MS} ms</span>
      </div>

      <div className="tpt-stage">
        {panel("host")}
        {panel("guest")}
      </div>

      <div className="tpt-log">
        <div className="tpt-log-title">Message log (newest first)</div>
        {log.length === 0 && <div className="tpt-log-empty">No messages yet.</div>}
        {log.map((e) => (
          <div key={e.id} className="tpt-log-row">
            <span className={`tpt-chip tpt-${e.from}`}>{e.from}</span>
            <code>{e.text}</code>
            {e.bytes > 0 && <span className={e.bytes < 512 ? "tpt-ok" : "tpt-bad"}>{e.bytes} B</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
