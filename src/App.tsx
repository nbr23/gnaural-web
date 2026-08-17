import type { DragEvent as ReactDragEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Route } from './app/routing';
import { AppFooter } from './app/AppFooter';
import { HeadphoneNotice } from './app/HeadphoneNotice';
import { LIBRARY, formatHash, navigate, redirect, useRoute } from './app/routing';
import { UpdatePrompt } from './app/UpdatePrompt';
import { useKeyboardShortcuts } from './app/useKeyboardShortcuts';
import { useSettings } from './app/useSettings';
import { newSchedule } from './document/edit';
import { parseSchedule, parseScheduleWithWarnings } from './document/parser';
import { serializeSchedule } from './document/serializer';
import type { Schedule } from './document/types';
import type { ScheduleWarning } from './document/warnings';
import { EditorView } from './editor/EditorView';
import { droppedFile, pickFile } from './files/openFile';
import { decodeSharePayload } from './files/shareLink';
import { LibraryView } from './library/LibraryView';
import { LiveView } from './live/LiveView';
import { DEFAULT_LIVE_VALUES, buildLiveSchedule } from './live/liveSchedule';
import { NowPlayingBar } from './library/NowPlayingBar';
import { findProgram, loadProgram } from './library/programs';
import type { ImportedProgram } from './library/storage';
import { getDraft } from './library/storage';
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
  /** A program the library asked to hear, by route key: what a press starts is not loaded yet. */
  const [autoplay, setAutoplay] = useState<string | null>(null);

  const noise = { colour: settings.noiseColour, gain: settings.noiseGain };
  const player = usePlayer(current?.schedule ?? null, settings.masterGain, noise);

  useMediaSession(player, current?.schedule.title ?? null, current?.subtitle);
  // Held here rather than in `PlayerView`, which unmounts while a program keeps playing.
  useWakeLock(settings.wakeLock && player.playing);
  useKeyboardShortcuts(
    player,
    route.view !== 'live',
    route.view === 'library' ? null : () => navigate(LIBRARY),
  );

  /** The route a resolution is in flight or settled for. */
  const resolving = useRef<string | null>(null);

  /**
   * Load what a route names, unless that load is already in flight or settled. Shared by the routed
   * load below and by the library's play buttons, which load without navigating.
   */
  const openRoute = useCallback(
    (route: Route) => {
      const key = formatHash(route);
      if (resolving.current === key) return;
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
          setAutoplay(null);
          if (!(thrown instanceof MissingProgramError)) {
            setError(thrown instanceof Error ? thrown.message : 'That program could not be read.');
          }
          redirect(LIBRARY);
        });
    },
    [library.imported],
  );

  useEffect(() => {
    if (route.view === 'library') return;
    openRoute(route);
  }, [route, openRoute]);

  const playerRef = useRef(player);
  playerRef.current = player;

  const armed = autoplay !== null && current !== null && formatHash(current.route) === autoplay;

  useEffect(() => {
    if (!armed) return;
    setAutoplay(null);
    playerRef.current.play();
  }, [armed]);

  /**
   * Play a program from its row in the library, without leaving it. `prime()` before the await:
   * an `AudioContext` opened after one is not opened inside the gesture that asked for sound.
   */
  const playRoute = useCallback(
    (target: Route) => {
      playerRef.current.prime();
      setAutoplay(formatHash(target));
      openRoute(target);
    },
    [openRoute],
  );

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
      navigate({ view: 'imported', id: (await library.add(name, text, schedule, 'file')).id });
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
    navigate({
      view: 'imported',
      id: (await library.add(name, text, current.schedule, 'link')).id,
    });
  }, [current, library]);

  /** Keep a live session as a program, by the same path an opened file takes. */
  const keepProgram = useCallback(
    async (schedule: Schedule, sourceName: string) => {
      const text = serializeSchedule(schedule);
      navigate({
        view: 'imported',
        id: (await library.add(sourceName, text, schedule, 'authored')).id,
      });
    },
    [library],
  );

  const newProgram = useCallback(async () => {
    const schedule = newSchedule('New program');
    const draft = await library.fork('scratch', serializeSchedule(schedule), schedule);
    navigate({ view: 'editor', id: draft.id });
  }, [library]);

  const editCopy = useCallback(async () => {
    if (!current) return;
    const { schedule } = current;
    const name = schedule.title.trim() || current.subtitle || 'Program';
    const draft = await library.fork(name, serializeSchedule(schedule), schedule);
    navigate({ view: 'editor', id: draft.id });
  }, [current, library]);

  const discardDraft = useCallback(
    async (id: string) => {
      if (current?.route.view === 'editor' && current.route.id === id) {
        resolving.current = null;
        setCurrent(null);
      }
      await library.discard(id);
      navigate(LIBRARY);
    },
    [current, library],
  );

  const removeImported = useCallback(
    async (id: string) => {
      if (current?.route.view === 'imported' && current.route.id === id) {
        resolving.current = null;
        setCurrent(null);
      }
      await library.remove(id);
    },
    [current, library],
  );

  const onLibrary = route.view === 'library';

  // The editor autosaves straight to IndexedDB on a debounce, so the mirrored list is stale by the
  // time anyone comes back to look at it.
  const { reloadDrafts } = library;
  useEffect(() => {
    if (onLibrary) void reloadDrafts();
  }, [onLibrary, reloadDrafts]);

  const awaiting = !onLibrary && !current && !error;
  const draftId = current?.route.view === 'editor' ? current.route.id : null;
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

      {hydrated && !settings.headphoneNoticeSeen && (
        <HeadphoneNotice onDismiss={() => set('headphoneNoticeSeen', true)} />
      )}

      {error && (
        <p className="app__error" role="alert">
          {error}
        </p>
      )}

      {!onLibrary && current && current.route.view === 'live' && (
        <LiveView
          player={player}
          storedBaseFreq={settings.liveBaseFreq}
          storedBeatFreq={settings.liveBeatFreq}
          hydrated={hydrated}
          onValuesChange={(values) => {
            set('liveBaseFreq', values.baseFreq);
            set('liveBeatFreq', values.beatFreq);
          }}
          masterGain={settings.masterGain}
          onMasterGainChange={(value) => set('masterGain', value)}
          noise={noise}
          onNoiseChange={(next) => {
            set('noiseColour', next.colour);
            set('noiseGain', next.gain);
          }}
          wakeLock={settings.wakeLock}
          onWakeLockChange={(enabled) => set('wakeLock', enabled)}
          onKeep={(schedule, sourceName) => void keepProgram(schedule, sourceName)}
        />
      )}
      {!onLibrary && current && draftId && (
        <EditorView
          // A different draft is a different history, not a state to merge into this one.
          key={draftId}
          draftId={draftId}
          initial={current.schedule}
          player={player}
          masterGain={settings.masterGain}
          onMasterGainChange={(value) => set('masterGain', value)}
          onSaveToLibrary={(schedule) =>
            void keepProgram(schedule, schedule.title.trim() || 'Draft')
          }
          onDiscard={() => void discardDraft(draftId)}
        />
      )}
      {!onLibrary && current && current.route.view !== 'live' && current.route.view !== 'editor' && (
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
          onEdit={() => void editCopy()}
        />
      )}
      {awaiting && <p className="app__loading">Loading…</p>}
      {onLibrary && (
        <LibraryView
          onOpenFile={() => void openFile()}
          onNewProgram={() => void newProgram()}
          imported={library.imported}
          onRemoveImported={(id) => void removeImported(id)}
          drafts={library.drafts}
          onDiscardDraft={(id) => void discardDraft(id)}
          transport={{
            active: nowPlaying
              ? { key: formatHash(nowPlaying.route), playing: player.playing }
              : null,
            onPlay: playRoute,
            onPause: player.pause,
            onStop: player.stop,
          }}
          favourites={settings.favourites}
          onFavouritesChange={(next) => set('favourites', next)}
          overrides={settings.sectionOverrides}
          onOverridesChange={(next) => set('sectionOverrides', next)}
        />
      )}
      {nowPlaying && (
        <NowPlayingBar
          title={nowPlaying.schedule.title.trim() || 'Untitled program'}
          player={player}
          openEnded={nowPlaying.route.view === 'live'}
          onOpen={() => navigate(nowPlaying.route)}
        />
      )}

      {dragging && <div className="app__drop-hint">Drop a .gnaural file to play it</div>}

      <AppFooter />
    </div>
  );
}

/** Turn a route into a playable program. */
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

    case 'editor': {
      const draft = await getDraft(route.id);
      if (!draft) throw new MissingProgramError();
      try {
        return { schedule: parseSchedule(draft.xml), warnings: [], subtitle: draft.sourceName };
      } catch {
        throw new Error(`${draft.title} could not be read.`);
      }
    }

    case 'live':
      return { schedule: buildLiveSchedule(DEFAULT_LIVE_VALUES), warnings: [] };

    case 'shared': {
      let schedule: Schedule;
      try {
        schedule = await decodeSharePayload(route.payload);
      } catch {
        throw new Error('That shared link could not be read.');
      }
      return {
        schedule,
        warnings: [],
        subtitle: schedule.author || 'Shared link',
        unsaved: { name: schedule.title.trim() || 'Shared program', text: serializeSchedule(schedule) },
      };
    }

    default:
      throw new MissingProgramError();
  }
}

export default App;
