import Game, { meta } from "./games/dotsandboxes";
import TwoPlayerTest from "./components/TwoPlayerTest";

export default function App() {
  return (
    <main className="app">
      <header className="app-header">
        <h1>
          {meta.emoji} {meta.name}
        </h1>
        <p>Local two-player test bench · host on the left, guest on the right · play both sides.</p>
      </header>
      <TwoPlayerTest Game={Game} />
    </main>
  );
}
