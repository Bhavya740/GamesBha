import { useState, type ComponentType } from "react";
import DotsAndBoxes, { meta as dotsMeta } from "./games/dotsandboxes";
import SamePage, { meta as samePageMeta } from "./games/samepage";
import TwoPlayerTest from "./components/TwoPlayerTest";
import type { GameProps } from "./games/dotsandboxes";

const GAMES: { meta: { id: string; name: string; emoji: string }; Game: ComponentType<GameProps> }[] = [
  { meta: dotsMeta, Game: DotsAndBoxes },
  { meta: samePageMeta, Game: SamePage },
];

function initialGame(): string {
  const q = new URLSearchParams(window.location.search).get("game");
  return GAMES.some((g) => g.meta.id === q) ? q! : GAMES[0].meta.id;
}

export default function App() {
  const [gameId, setGameId] = useState(initialGame);
  const current = GAMES.find((g) => g.meta.id === gameId)!;

  const pick = (id: string) => {
    setGameId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("game", id);
    window.history.replaceState(null, "", url);
  };

  return (
    <main className="app">
      <header className="app-header">
        <div className="app-tabs" role="tablist" aria-label="Game">
          {GAMES.map((g) => (
            <button
              key={g.meta.id}
              type="button"
              role="tab"
              aria-selected={g.meta.id === gameId}
              className={`app-tab ${g.meta.id === gameId ? "app-tab-on" : ""}`}
              onClick={() => pick(g.meta.id)}
            >
              {g.meta.emoji} {g.meta.name}
            </button>
          ))}
        </div>
        <h1>
          {current.meta.emoji} {current.meta.name}
        </h1>
        <p>Local two-player test bench · host on the left, guest on the right · play both sides.</p>
      </header>
      {/* key: switching games gives a fresh bridge and fresh game instances */}
      <TwoPlayerTest key={gameId} Game={current.Game} />
    </main>
  );
}
