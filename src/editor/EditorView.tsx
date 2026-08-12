import { useCallback, useEffect, useRef, useState } from 'react';
import { formatClock } from '../app/format';
import { LIBRARY, navigate } from '../app/routing';
import { useThrottled } from '../app/useThrottled';
import type { MoveMode, VoiceEdit } from '../document/edit';
import { updateSchedule } from '../document/edit';
import type { Schedule } from '../document/types';
import type { VoiceMap } from '../document/voiceMap';
import { composeVoiceMaps } from '../document/voiceMap';
import { VolumeSlider } from '../player/Controls';
import { Readout } from '../player/Readout';
import { Timeline } from '../player/Timeline';
import type { Player } from '../player/usePlayer';
import type { LaneId } from '../viz/geometry';
import { ALL_LANES, DEFAULT_LANES } from '../viz/geometry';
import { CommittedField } from './CommittedField';
import { EditSurface } from './EditSurface';
import { NodePanel } from './NodePanel';
import { VoiceRows } from './VoiceRows';
import type { NodeRef } from './history';
import { useDraft } from './useDraft';
import { useEditor } from './useEditor';
import './EditorView.css';

/**
 * Lane heights, chosen so four lanes are usable rather than four times a quarter of a fixed box.
 *
 * §6.1 asks for independently collapsible lanes and this is why it could not wait for step 8: the
 * chart divides its total height between however many lanes it is given, so beat, base and both
 * volumes inside the read-only 280 px leaves about 44 px of plot each — unusable before it is
 * unzoomable.
 */
const LANE_HEIGHT = 116;
const AXIS_BAND = 30;

const LANE_LABELS: Record<LaneId, string> = {
  beat: 'Beat',
  base: 'Base',
  volumeLeft: 'Volume L',
  volumeRight: 'Volume R',
};

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

  // Session state, deliberately outside the history stack: which lanes are open and how a drag
  // treats the following segment are properties of the person editing, not of the document.
  const [lanes, setLanes] = useState<readonly LaneId[]>(DEFAULT_LANES);
  const [mode, setMode] = useState<MoveMode>('squeeze');

  const patch = useCallback(
    (label: string, fields: Parameters<typeof updateSchedule>[1]) => {
      editor.commit(updateSchedule(schedule, fields), { label });
    },
    [editor, schedule],
  );

  const commitEdit = useCallback(
    (next: Schedule, label: string) => editor.commit(next, { label }),
    [editor],
  );

  /**
   * An edit that shifts entry indices. The commit records the selection it *had* (undo restores
   * that); this sets where the selection lands *after* it, which only the command knows.
   */
  const commitEditAt = useCallback(
    (next: Schedule, label: string, selection: NodeRef | null) => {
      editor.commit(next, { label });
      editor.select(selection);
    },
    [editor],
  );

  /**
   * An edit that moves voices, which is the only kind that owes a map.
   *
   * With no explicit selection the current one is carried across the edit's own map, so reordering
   * one voice cannot pull the selection off a node in another — and deleting the voice it was in
   * drops it, because the map says the voice went nowhere.
   */
  const commitStructure = useCallback(
    (edit: VoiceEdit, label: string, selection?: NodeRef | null) => {
      const current = editor.selection;
      editor.commit(edit.schedule, { label, voiceMap: edit.voiceMap });
      if (selection !== undefined) editor.select(selection);
      else if (current) editor.select(followVoice(current, edit.voiceMap));
    },
    [editor],
  );

  const { preview } = usePlaybackOfEdits(player, initial, schedule, editor.voiceMap);
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

      <div className="editor__lanes">
        <span className="editor__lanes-label">Lanes</span>
        {ALL_LANES.map((lane) => (
          <label key={lane} className="editor__check">
            <input
              type="checkbox"
              checked={lanes.includes(lane)}
              onChange={(event) =>
                setLanes(
                  event.target.checked
                    ? ALL_LANES.filter((id) => id === lane || lanes.includes(id))
                    : lanes.filter((id) => id !== lane),
                )
              }
            />
            <span>{LANE_LABELS[lane]}</span>
          </label>
        ))}

        {/* There is no modifier key on a phone, so the squeeze/ripple choice is a control rather
            than a chord. Alt is a momentary override on a keyboard, handled in `EditSurface`. */}
        <label className="editor__check editor__mode">
          <input
            type="checkbox"
            checked={mode === 'ripple'}
            onChange={(event) => setMode(event.target.checked ? 'ripple' : 'squeeze')}
          />
          <span>Ripple — move everything after the node too</span>
        </label>
      </div>

      <EditSurface
        schedule={schedule}
        lanes={lanes}
        height={Math.max(1, lanes.length) * LANE_HEIGHT + AXIS_BAND}
        currentTime={player.offset}
        selected={editor.selection}
        mode={mode}
        onSelect={editor.select}
        onCommit={commitEdit}
        onCommitAt={commitEditAt}
        onPreview={preview}
        onSeek={player.seek}
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

      <VoiceRows
        schedule={schedule}
        gates={player.voiceGates}
        onCommit={commitEdit}
        onStructural={commitStructure}
        onToggleSolo={player.toggleSolo}
      />

      <NodePanel
        schedule={schedule}
        selected={editor.selection}
        mode={mode}
        onCommit={commitEdit}
        onCommitAt={commitEditAt}
      />

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
function usePlaybackOfEdits(
  player: Player,
  initial: Schedule,
  schedule: Schedule,
  voiceMap: VoiceMap | null,
): { preview: (next: Schedule) => void } {
  const pushed = useRef(initial);
  /**
   * The map from the document last actually pushed to the one about to be.
   *
   * **It has to accumulate**, because the throttle below keeps only the most recent action: two
   * structural commits inside one interval — held-down undo across a reorder is the obvious way —
   * deliver one document, and a map that described only the second half of that journey would put
   * the session gates on the wrong voices. Null while nothing structural is outstanding, so the
   * ordinary case allocates nothing.
   */
  const pending = useRef<VoiceMap | null>(null);

  // Not memoised: `useThrottled` always calls the most recent action it was given, so a pending
  // push cannot reach a player this render has already replaced.
  const push = useThrottled((next: Schedule) => {
    const map = pending.current;
    pending.current = null;
    player.update(next, undefined, map ?? undefined);
  });

  useEffect(() => {
    if (!affectsAudio(pushed.current, schedule)) return;
    if (voiceMap) {
      pending.current = pending.current
        ? composeVoiceMaps(pending.current, voiceMap)
        : voiceMap;
    }
    pushed.current = schedule;
    push(schedule);
  }, [push, schedule, voiceMap]);

  /**
   * The in-flight document from a gesture. **The only caller of the truncated editing horizon**, and
   * the reason it is safe: forgetting to opt in costs nothing, and the commit that ends the gesture
   * goes through the ordinary full-horizon path above — so a forgotten expansion makes the edit not
   * exist, which is undeniable, rather than making the audio go quiet in sixty seconds.
   *
   * Already rate-limited inside `EditSurface`; this only routes it and marks the horizon.
   *
   * A drag can move no voice, so it never *makes* a map — but it can begin inside the throttle
   * window of a structural commit that has not gone out yet, and pushing past an outstanding map
   * would apply this document to gates the previous edit has not finished moving. So it carries and
   * clears one if there is one, which is the whole of what "never lose a map" requires here.
   */
  const preview = useCallback(
    (next: Schedule) => {
      const map = pending.current;
      pending.current = null;
      pushed.current = next;
      player.update(next, 'gesture', map ?? undefined);
    },
    [player],
  );

  return { preview };
}

/** Where a node's voice ended up. A voice the edit deleted takes the selection with it. */
function followVoice(node: NodeRef, map: VoiceMap): NodeRef | null {
  const voice = map[node.voice];
  return voice === undefined || voice < 0 ? null : { voice, entry: node.entry };
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
