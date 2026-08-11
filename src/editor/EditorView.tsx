import { useCallback, useEffect, useRef } from 'react';
import { formatClock } from '../app/format';
import { LIBRARY, navigate } from '../app/routing';
import { useThrottled } from '../app/useThrottled';
import { updateSchedule } from '../document/edit';
import type { Schedule } from '../document/types';
import { VolumeSlider } from '../player/Controls';
import { Readout } from '../player/Readout';
import { Timeline } from '../player/Timeline';
import type { Player } from '../player/usePlayer';
import { ScheduleChart } from '../viz/ScheduleChart';
import { CommittedField } from './CommittedField';
import { useDraft } from './useDraft';
import { useEditor } from './useEditor';
import './EditorView.css';

export interface EditorViewProps {
  draftId: string;
  /**
   * The draft as it was read from storage. The editor owns the document from here — this prop is
   * also what `usePlayer` was handed, and it must keep its identity, because the player's load
   * effect keys `load()`, a teardown, on it. Edits reach the engine through `player.update` below.
   */
  initial: Schedule;
  player: Player;
  masterGain: number;
  onMasterGainChange(value: number): void;
  /** Publish the draft as a program, by exactly the path an imported file takes. */
  onSaveToLibrary(schedule: Schedule): void;
  onDiscard(): void;
}

/**
 * The editor shell (PLAN.md §6.1): a draft, a command stack, and the document's own header.
 *
 * The editing *surface* — nodes, lanes, dragging — is the next step. What is here is the part that
 * has to exist before any of that: somewhere for a document to live that is not a program in the
 * library, undo and redo from the first commit rather than retrofitted, and an autosave, so half an
 * hour of authoring cannot be lost to a closed tab.
 */
export function EditorView({
  draftId,
  initial,
  player,
  masterGain,
  onMasterGainChange,
  onSaveToLibrary,
  onDiscard,
}: EditorViewProps) {
  const editor = useEditor(initial);
  const schedule = editor.document;
  const { pending } = useDraft(draftId, schedule);

  const patch = useCallback(
    (label: string, fields: Parameters<typeof updateSchedule>[1]) => {
      editor.commit(updateSchedule(schedule, fields), { label });
    },
    [editor, schedule],
  );

  usePlaybackOfEdits(player, initial, schedule);
  useUndoShortcuts(editor.undo, editor.redo);

  const title = schedule.title.trim() || 'Untitled program';

  return (
    <div className="editor">
      <header className="editor__header">
        <button type="button" className="back-link" onClick={() => navigate(LIBRARY)}>
          ← Library
        </button>
        <h1 className="editor__title">{title}</h1>
        <p className="editor__state">{pending ? 'Saving…' : 'Draft — saved automatically'}</p>
      </header>

      <div className="editor__history">
        <button type="button" className="button" disabled={!editor.canUndo} onClick={editor.undo}>
          Undo{editor.undoLabel ? ` ${editor.undoLabel.toLowerCase()}` : ''}
        </button>
        <button type="button" className="button" disabled={!editor.canRedo} onClick={editor.redo}>
          Redo{editor.redoLabel ? ` ${editor.redoLabel.toLowerCase()}` : ''}
        </button>
      </div>

      <Readout schedule={schedule} offset={player.offset} />

      <ScheduleChart
        schedule={schedule}
        currentTime={player.offset}
        onSeek={player.seek}
        className="editor__chart"
      />

      <Timeline offset={player.offset} duration={player.duration} onSeek={player.seek} />

      <div className="editor__transport">
        <button
          type="button"
          className="button button--primary"
          onClick={() => (player.playing ? player.pause() : player.play())}
        >
          {player.playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="button" onClick={player.stop}>
          Stop
        </button>
        <span className="editor__elapsed">{formatClock(player.offset)}</span>
      </div>

      <VolumeSlider value={masterGain} onChange={onMasterGainChange} />

      <section className="editor__fields">
        <h2>Program</h2>

        <CommittedField
          label="Title"
          value={schedule.title}
          onCommit={(value) => patch('Rename program', { title: value })}
        />
        <CommittedField
          label="Author"
          value={schedule.author}
          onCommit={(value) => patch('Change author', { author: value })}
        />
        <CommittedField
          label="Description"
          value={schedule.description}
          multiline
          onCommit={(value) => patch('Change description', { description: value })}
        />

        <div className="editor__row">
          {/* §3.2: 1 plays once, anything below it repeats until stopped. */}
          <CommittedField
            label="Repeats"
            value={String(schedule.loops)}
            numeric
            hint={schedule.loops <= 0 ? 'Repeats until stopped' : `Plays ${schedule.loops}×`}
            onCommit={(value) => patch('Change repeats', { loops: numberOr(value, schedule.loops) })}
          />
          {/* The document's own mix (§3.2), written into the file — not the listening level above,
              which belongs to whoever is listening. Typed rather than dragged, per §6.1's "dragging
              is imprecise and people want exact values". */}
          <CommittedField
            label="Volume left"
            value={String(schedule.masterVolume.left)}
            numeric
            onCommit={(value) =>
              patch('Change master volume', {
                masterVolume: {
                  ...schedule.masterVolume,
                  left: numberOr(value, schedule.masterVolume.left),
                },
              })
            }
          />
          <CommittedField
            label="Volume right"
            value={String(schedule.masterVolume.right)}
            numeric
            onCommit={(value) =>
              patch('Change master volume', {
                masterVolume: {
                  ...schedule.masterVolume,
                  right: numberOr(value, schedule.masterVolume.right),
                },
              })
            }
          />
        </div>

        <label className="editor__check">
          <input
            type="checkbox"
            checked={schedule.stereoSwap}
            onChange={(event) => patch('Toggle stereo swap', { stereoSwap: event.target.checked })}
          />
          <span>Swap left and right on output</span>
        </label>
      </section>

      <section className="editor__publish">
        <h2>Finish</h2>
        <p className="editor__publish-note">
          Saving puts a copy in your library, where it can be exported as a WAV or a .gnaural file
          and shared as a link. The draft stays here to keep working on.
        </p>
        <div className="editor__row">
          <button type="button" className="button" onClick={() => onSaveToLibrary(schedule)}>
            Save to library
          </button>
          <button type="button" className="button" onClick={onDiscard}>
            Discard draft
          </button>
        </div>
      </section>
    </div>
  );
}

function numberOr(value: string, fallback: number): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Push edits at the running engine, without a teardown and without rescheduling for edits nobody
 * can hear.
 *
 * **Only what is audible is pushed.** §4.1 makes the document immutable and the transforms reuse
 * everything they do not touch, so "did the audio change?" really is a reference comparison. A
 * title is not audio; `voices`, the master volumes, the swap and the repeat count are.
 *
 * Throttled for the same reason Live mode is: a transition is ~70 ms wide, and calling faster than
 * that cancels the previous ramp before it has landed. Held-down undo is the surface here that can
 * outrun it.
 */
function usePlaybackOfEdits(player: Player, initial: Schedule, schedule: Schedule): void {
  const pushed = useRef(initial);
  // Not memoised: `useThrottled` always calls the most recent action it was given, so a pending
  // push cannot reach a player this render has already replaced.
  const push = useThrottled((next: Schedule) => player.update(next));

  useEffect(() => {
    if (!affectsAudio(pushed.current, schedule)) return;
    pushed.current = schedule;
    push(schedule);
  }, [push, schedule]);
}

function affectsAudio(previous: Schedule, next: Schedule): boolean {
  return (
    previous.voices !== next.voices ||
    previous.masterVolume !== next.masterVolume ||
    previous.stereoSwap !== next.stereoSwap ||
    previous.loops !== next.loops
  );
}

/**
 * Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z, on the window rather than on a focused element — undo is about
 * the document, not about whatever happens to have focus.
 *
 * Except inside a text field, where the browser's own undo is the better answer: it works on the
 * characters being typed, which have not been committed to the document yet.
 */
function useUndoShortcuts(undo: () => void, redo: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey)) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [redo, undo]);
}
