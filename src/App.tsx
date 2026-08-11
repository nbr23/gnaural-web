import type { DragEvent as ReactDragEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Route } from './app/routing';
import { HeadphoneNotice } from './app/HeadphoneNotice';
import { LIBRARY, formatHash, navigate, redirect, useRoute } from './app/routing';
import { UpdatePrompt } from './app/UpdatePrompt';
import { useSettings } from './app/useSettings';
import { parseSchedule, parseScheduleWithWarnings } from './document/parser';
import { serializeSchedule } from './document/serializer';
import type { Schedule } from './document/types';
import type { ScheduleWarning } from './document/warnings';
import { droppedFile, pickFile } from './files/openFile';
import { decodeSharePayload } from './files/shareLink';
import { LibraryView } from './library/LibraryView';
import { NowPlayingBar } from './library/NowPlayingBar';
import { findProgram, loadProgram } from './library/programs';
import type { ImportedProgram } from './library/storage';
import { useLibrary } from './library/useLibrary';
import { PlayerView } from './player/PlayerView';
import { useMediaSession } from './player/useMediaSession';
import { usePlayer } from './player/usePlayer';
import { useWakeLock } from './player/useWakeLock';
import './App.css';

interface LoadedProgram {
  /** The route this was resolved for, so re-entering it does not re-parse and reload the engine. */
  route: Route;
  schedule: Schedule;
  /**
   * What §3.4's defensive parse absorbed. Held per loaded program rather than persisted with an
   * imported one: recomputing costs a parse that has already happened, and a stored list could
   * drift from the file it describes.
   */
  warnings: ScheduleWarning[];
  /** Byline for the player — a bundled program's credit, or the file it arrived as. */
  subtitle?: string;
  /** Set when the program is not in the library yet, and is therefore worth offering to keep. */
  unsaved?: { name: string; text: string };
}

/** Thrown when a route names something that no longer exists; the app redirects rather than sits. */
class MissingProgramError extends Error {}

function App() {
  const route = useRoute();
  const library = useLibrary();
  const { settings, hydrated, set } = useSettings();
  const [current, setCurrent] = useState<LoadedProgram | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Rebuilt on every render, which `usePlayer` tolerates by depending on the two values.
  const noise = { colour: settings.noiseColour, gain: settings.noiseGain };
  const player = usePlayer(current?.schedule ?? null, settings.masterGain, noise);

  useMediaSession(player, current?.schedule.title ?? null, current?.subtitle);
  // Held here rather than in `PlayerView`, which unmounts while a program keeps playing.
  useWakeLock(settings.wakeLock && player.playing);

  /**
   * The route a resolution is in flight or settled for.
   *
   * A ref rather than an effect cleanup flag because the effect re-runs on things the resolution
   * does not depend on — the library read settling, most obviously — and a cleanup-based cancel
   * would abandon a load that is still perfectly valid.
   */
  const resolving = useRef<string | null>(null);

  useEffect(() => {
    // Going back to the library keeps the program loaded, and therefore keeps it playing: the
    // now-playing bar and the lock screen are both transport enough to leave audio running behind.
    if (route.view === 'library') return;

    const key = formatHash(route);
    if (resolving.current === key) return;
    // An imported route names an IndexedDB key, so it cannot be resolved before the read settles.
    if (route.view === 'imported' && !library.imported) return;

    resolving.current = key;
    setCurrent(null);
    setError(null);

    resolveRoute(route, library.imported ?? [])
      .then((resolved) => {
        if (resolving.current === key) setCurrent({ route, ...resolved });
      })
      .catch((thrown) => {
        if (resolving.current !== key) return;
        resolving.current = null;
        // Back to the library either way — a route that resolved to nothing has nothing to show,
        // and the banner explains it there. A route that named something that never existed says
        // nothing at all, because there is no program to name.
        if (!(thrown instanceof MissingProgramError)) {
          setError(thrown instanceof Error ? thrown.message : 'That program could not be read.');
        }
        redirect(LIBRARY);
      });
  }, [route, library.imported]);

  const accept = useCallback(
    async (name: string, text: string) => {
      let schedule: Schedule;
      try {
        schedule = parseSchedule(text);
      } catch {
        setError(`${name} could not be read as a Gnaural schedule.`);
        return;
      }

      setError(null);
      // Every file the user opens is kept. Nothing is session-only any more, so a reload, a share
      // and a return visit all land on the same program.
      navigate({ view: 'imported', id: (await library.add(name, text, schedule)).id });
    },
    [library],
  );

  const openFile = useCallback(async () => {
    const file = await pickFile();
    if (file) await accept(file.name, file.text);
  }, [accept]);

  const onDrop = useCallback(
    async (event: ReactDragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = await droppedFile(event.dataTransfer);
      if (file) await accept(file.name, file.text);
    },
    [accept],
  );

  const saveToLibrary = useCallback(async () => {
    if (!current?.unsaved) return;
    const { name, text } = current.unsaved;
    navigate({ view: 'imported', id: (await library.add(name, text, current.schedule)).id });
  }, [current, library]);

  const removeImported = useCallback(
    async (id: string) => {
      // Deleting what is loaded also unloads it, which stops it — a program with no library entry
      // and no route to return to has nowhere left to be.
      if (current?.route.view === 'imported' && current.route.id === id) {
        resolving.current = null;
        setCurrent(null);
      }
      await library.remove(id);
    },
    [current, library],
  );

  const onLibrary = route.view === 'library';
  const awaiting = !onLibrary && !current && !error;
  // Only once it has actually been started: a program merely opened and left has nothing to show.
  const nowPlaying = onLibrary && current && (player.playing || player.offset > 0) ? current : null;

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
      <UpdatePrompt />

      {/* Gated on the settings read, not just the flag: the default is "not yet seen", so
          rendering before the read lands would flash this on every launch. */}
      {hydrated && !settings.headphoneNoticeSeen && (
        <HeadphoneNotice onDismiss={() => set('headphoneNoticeSeen', true)} />
      )}

      {error && (
        <p className="app__error" role="alert">
          {error}
        </p>
      )}

      {!onLibrary && current && (
        <PlayerView
          schedule={current.schedule}
          warnings={current.warnings}
          subtitle={current.subtitle}
          player={player}
          masterGain={settings.masterGain}
          onMasterGainChange={(value) => set('masterGain', value)}
          noise={noise}
          onNoiseChange={(next) => {
            set('noiseColour', next.colour);
            set('noiseGain', next.gain);
          }}
          lostAmbientBed={
            current.route.view === 'program' && findProgram(current.route.id)?.lostAmbientBed
          }
          exportSampleRate={settings.exportSampleRate}
          onExportSampleRateChange={(rate) => set('exportSampleRate', rate)}
          wakeLock={settings.wakeLock}
          onWakeLockChange={(enabled) => set('wakeLock', enabled)}
          onSaveToLibrary={current.unsaved ? () => void saveToLibrary() : undefined}
        />
      )}
      {awaiting && <p className="app__loading">Loading…</p>}
      {onLibrary && (
        <LibraryView
          onOpenFile={() => void openFile()}
          imported={library.imported}
          onRemoveImported={(id) => void removeImported(id)}
        />
      )}
      {nowPlaying && (
        <NowPlayingBar
          title={nowPlaying.schedule.title.trim() || 'Untitled program'}
          player={player}
          onOpen={() => navigate(nowPlaying.route)}
        />
      )}

      {dragging && <div className="app__drop-hint">Drop a .gnaural file to play it</div>}
    </div>
  );
}

/**
 * Turn a route into a playable program.
 *
 * The three sources differ only in where the XML comes from: a lazily imported bundle chunk, an
 * IndexedDB row, or the fragment itself.
 */
async function resolveRoute(
  route: Route,
  imported: ImportedProgram[],
): Promise<Omit<LoadedProgram, 'route'>> {
  switch (route.view) {
    case 'program': {
      const program = findProgram(route.id);
      if (!program) throw new MissingProgramError();
      try {
        return { ...(await loadProgram(route.id)), subtitle: program.author || undefined };
      } catch {
        throw new Error(`${program.title} could not be loaded.`);
      }
    }

    case 'imported': {
      const program = imported.find((candidate) => candidate.id === route.id);
      if (!program) throw new MissingProgramError();
      try {
        return { ...parseScheduleWithWarnings(program.text), subtitle: program.sourceName };
      } catch {
        throw new Error(`${program.title} could not be read.`);
      }
    }

    case 'shared': {
      let schedule: Schedule;
      try {
        schedule = await decodeSharePayload(route.payload);
      } catch {
        throw new Error('That shared link could not be read.');
      }
      return {
        schedule,
        // A link carries a `Schedule`, never XML, so §3.4's file-level warnings cannot apply to
        // one — whatever the original file said about itself did not survive serialization.
        // `scheduleWarnings` still runs over it in the player.
        warnings: [],
        subtitle: schedule.author || 'Shared link',
        // The link carried the program, not a file, so re-serializing is the honest source text.
        unsaved: { name: schedule.title.trim() || 'Shared program', text: serializeSchedule(schedule) },
      };
    }

    default:
      throw new MissingProgramError();
  }
}

export default App;
