import { useEffect, useRef, useState } from 'react';
import powernapXml from '../fixtures/powernap.gnaural?raw';
import { parseSchedule } from './document/parser';
import { PlaybackEngine } from './engine/engine';
import './App.css';

// Manual-test harness for the engine (steps 3-4): a hardcoded fixture wired to transport
// controls so playback and seeking can be verified by ear. Replaced by the real player UI in
// build-order step 6 (see PROGRESS.md).
const schedule = parseSchedule(powernapXml);
const SEEK_STEP_SECONDS = 10;

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function App() {
  const engineRef = useRef<PlaybackEngine | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  function getEngine(): PlaybackEngine {
    if (!engineRef.current) {
      engineRef.current = new PlaybackEngine();
      engineRef.current.load(schedule);
    }
    return engineRef.current;
  }

  // Playhead readout — polls the engine's clock rather than driving it with a JS timer
  // (PLAN.md §4 — the audio thread carries timing; the UI only observes it).
  useEffect(() => {
    if (!playing) return;
    let frame: number;
    const tick = () => {
      setElapsed(engineRef.current?.getCurrentOffset() ?? 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  function handlePlayPause() {
    const engine = getEngine();
    if (playing) {
      engine.pause();
    } else {
      engine.play();
    }
    setPlaying(!playing);
    setElapsed(engine.getCurrentOffset());
  }

  function handleStop() {
    engineRef.current?.stop();
    setPlaying(false);
    setElapsed(0);
  }

  function handleSeek(deltaSeconds: number) {
    const engine = getEngine();
    engine.seek(engine.getCurrentOffset() + deltaSeconds);
    setElapsed(engine.getCurrentOffset());
  }

  return (
    <section id="center">
      <h1>Gnaural Web</h1>
      <p>
        Engine smoke test — playing <strong>{schedule.title}</strong> ({schedule.voices.length}{' '}
        voice{schedule.voices.length === 1 ? '' : 's'}). Headphones required.
      </p>
      <p className="elapsed">{formatTime(elapsed)}</p>
      <div className="transport">
        <button type="button" onClick={() => handleSeek(-SEEK_STEP_SECONDS)}>
          -{SEEK_STEP_SECONDS}s
        </button>
        <button type="button" onClick={handlePlayPause}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" onClick={() => handleSeek(SEEK_STEP_SECONDS)}>
          +{SEEK_STEP_SECONDS}s
        </button>
        <button type="button" onClick={handleStop}>
          Stop
        </button>
      </div>
    </section>
  );
}

export default App;
