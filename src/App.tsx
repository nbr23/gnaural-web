import type { DragEvent as ReactDragEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { LIBRARY, redirect, useRoute } from './app/routing';
import type { Schedule } from './document/types';
import { parseSchedule } from './document/parser';
import { droppedFile, pickFile } from './files/openFile';
import { LibraryView } from './library/LibraryView';
import { findProgram, loadProgram } from './library/programs';
import { PlayerView } from './player/PlayerView';
import { usePlayer } from './player/usePlayer';
import './App.css';

interface LoadedProgram {
  schedule: Schedule;
  /** Byline for the player — a bundled program's credit, or the opened file's name. */
  subtitle?: string;
}

function App() {
  const route = useRoute();
  const [loaded, setLoaded] = useState<LoadedProgram | null>(null);
  const [opened, setOpened] = useState<LoadedProgram | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const active = route.view === 'opened' ? opened : route.view === 'program' ? loaded : null;
  const awaitingProgram = route.view === 'program' && !active && !error;
  const player = usePlayer(active?.schedule ?? null);

  // Bundled programs are fetched per route; each is its own lazily imported chunk.
  useEffect(() => {
    if (route.view !== 'program') return;

    const program = findProgram(route.id);
    if (!program) {
      redirect(LIBRARY);
      return;
    }

    let cancelled = false;
    setLoaded(null);
    setError(null);
    loadProgram(route.id)
      .then((schedule) => {
        if (!cancelled) setLoaded({ schedule, subtitle: program.author || undefined });
      })
      .catch(() => {
        if (!cancelled) setError(`${program.title} could not be loaded.`);
      });

    return () => {
      cancelled = true;
    };
  }, [route]);

  // An opened file lives in memory only, so a reload lands on a route with nothing behind it.
  useEffect(() => {
    if (route.view === 'opened' && !opened) redirect(LIBRARY);
  }, [route, opened]);

  const accept = useCallback((name: string, text: string) => {
    try {
      setOpened({ schedule: parseSchedule(text), subtitle: name });
      setError(null);
      window.location.hash = '#/opened';
    } catch {
      setError(`${name} could not be read as a Gnaural schedule.`);
    }
  }, []);

  const openFile = useCallback(async () => {
    const file = await pickFile();
    if (file) accept(file.name, file.text);
  }, [accept]);

  const onDrop = useCallback(
    async (event: ReactDragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = await droppedFile(event.dataTransfer);
      if (file) accept(file.name, file.text);
    },
    [accept],
  );

  return (
    <div
      className={`app${dragging ? ' app--dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {error && (
        <p className="app__error" role="alert">
          {error}
        </p>
      )}

      {active && <PlayerView schedule={active.schedule} subtitle={active.subtitle} player={player} />}
      {awaitingProgram && <p className="app__loading">Loading…</p>}
      {!active && !awaitingProgram && <LibraryView onOpenFile={openFile} />}

      {dragging && <div className="app__drop-hint">Drop a .gnaural file to play it</div>}
    </div>
  );
}

export default App;
