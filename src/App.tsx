import { useRef, useState } from 'react';
import powernapXml from '../fixtures/powernap.gnaural?raw';
import { parseSchedule } from './document/parser';
import { PlaybackEngine } from './engine/engine';
import './App.css';

// Step 3 manual-test harness: a hardcoded fixture wired to the engine so playback can be
// verified by ear. Replaced by the real player UI in build-order step 6 (see PROGRESS.md).
const schedule = parseSchedule(powernapXml);

function App() {
  const engineRef = useRef<PlaybackEngine | null>(null);
  const [playing, setPlaying] = useState(false);

  function handlePlay() {
    engineRef.current ??= new PlaybackEngine();
    engineRef.current.play(schedule);
    setPlaying(true);
  }

  function handleStop() {
    engineRef.current?.stop();
    setPlaying(false);
  }

  return (
    <section id="center">
      <h1>Gnaural Web</h1>
      <p>
        Engine smoke test — playing <strong>{schedule.title}</strong> ({schedule.voices.length}{' '}
        voice{schedule.voices.length === 1 ? '' : 's'}). Headphones required.
      </p>
      <div className="transport">
        <button type="button" onClick={handlePlay} disabled={playing}>
          Play
        </button>
        <button type="button" onClick={handleStop} disabled={!playing}>
          Stop
        </button>
      </div>
    </section>
  );
}

export default App;
