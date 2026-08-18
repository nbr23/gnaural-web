import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from '../app/Panel';
import { numberOr } from '../app/format';
import { LIBRARY, navigate } from '../app/routing';
import { isTypingTarget } from '../app/useKeyboardShortcuts';
import { useWideLayout } from '../app/useMediaQuery';
import { useThrottled } from '../app/useThrottled';
import type { MoveMode, VoiceEdit } from '../document/edit';
import { padVoicesToLongest, repairVoiceGrouping, updateSchedule } from '../document/edit';
import type { Schedule } from '../document/types';
import type { VoiceMap } from '../document/voiceMap';
import { composeVoiceMaps } from '../document/voiceMap';
import type { EntryWarning, WarningKind } from '../document/warnings';
import { entryWarnings, scheduleWarnings } from '../document/warnings';
import { PlayPauseButton, StopButton, VolumeSlider } from '../player/Controls';
import { Readout } from '../player/Readout';
import { Timeline } from '../player/Timeline';
import type { Player } from '../player/usePlayer';
import type { ChartMark, LaneDomains, LaneId } from '../viz/geometry';
import { ALL_LANES, DEFAULT_LANES, EDITOR_DOMAIN_PADDING, buildChartModel } from '../viz/geometry';
import { AuthoringPanel } from './AuthoringPanel';
import { CommittedField } from './CommittedField';
import { EditSurface } from './EditSurface';
import { GroupPanel } from './GroupPanel';
import { LaneRanges } from './LaneRanges';
import { NodePanel } from './NodePanel';
import type { WarningRepair } from './ValidationPanel';
import { ValidationPanel } from './ValidationPanel';
import { VoiceRows } from './VoiceRows';
import type { NodeRef, Selection } from './history';
import { useDraft } from './useDraft';
import { useEditor } from './useEditor';
import './EditorView.css';

const LANE_HEIGHT = 116;
// Floor for the fourth lane when the stage has to fit beside the panels — still twice the ~44px
// that made a fixed-height box unusable with four lanes open.
const MIN_LANE_HEIGHT = 90;
const AXIS_BAND = 30;
// Everything in the stage besides the plot (header, chips, transport, etc), measured in-browser at
// 1280x900 rather than summed from the stylesheet — only needs to be close.
const STAGE_CHROME_PX = 480;

const LANE_LABELS: Record<LaneId, string> = {
  beat: 'Beat',
  base: 'Base',
  volumeLeft: 'Volume L',
  volumeRight: 'Volume R',
};

export interface EditorViewProps {
  draftId: string;
  // Must keep its identity across renders: usePlayer keys its load-teardown effect on this prop.
  initial: Schedule;
  player: Player;
  masterGain: number;
  onMasterGainChange(value: number): void;
  onSaveToLibrary(schedule: Schedule): void;
  onDiscard(): void;
}

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

  // Session state, kept outside the history stack: properties of the person editing, not the
  // document. The view window itself lives further down in EditSurface, since it changes at
  // pointer rate.
  const [lanes, setLanes] = useState<readonly LaneId[]>(DEFAULT_LANES);
  const [mode, setMode] = useState<MoveMode>('squeeze');
  const [snap, setSnap] = useState(false);
  const [domains, setDomains] = useState<LaneDomains>({});
  const [discarding, setDiscarding] = useState(false);

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

  // The commit records the selection it had, for undo; this sets where it lands after, which only
  // the caller knows.
  const commitEditAt = useCallback(
    (next: Schedule, label: string, selection: Selection) => {
      editor.commit(next, { label });
      editor.select(selection);
    },
    [editor],
  );

  // With no explicit selection, the current one is carried across the edit's own voice map, so a
  // deleted voice drops the selection rather than leaving it pointing at the wrong voice.
  const commitStructure = useCallback(
    (edit: VoiceEdit, label: string, selection?: NodeRef | null) => {
      const current = editor.selection;
      editor.commit(edit.schedule, { label, voiceMap: edit.voiceMap });
      if (selection !== undefined) editor.select(selection ? [selection] : []);
      else editor.select(followVoices(current, edit.voiceMap));
    },
    [editor],
  );

  const { preview } = usePlaybackOfEdits(player, initial, schedule, editor.voiceMap);
  useUndoShortcuts(editor.undo, editor.redo);

  // Validation runs over the committed document: the in-flight document of a drag never leaves
  // EditSurface, so `schedule` here is always the last committed state.
  const warnings = useMemo(() => scheduleWarnings(schedule), [schedule]);
  const issues = useMemo(() => entryWarnings(schedule), [schedule]);
  const marks = useMemo(() => chartMarks(issues), [issues]);
  const silent = warnings.some((warning) => warning.kind === 'nothing-to-play');

  // Memoised on the document alone: this view re-renders on every playhead tick, and these repair
  // transforms are not cheap enough to run that often just to decide whether a button should show.
  const repaired = useMemo(
    () => ({ padded: padVoicesToLongest(schedule), regrouped: repairVoiceGrouping(schedule) }),
    [schedule],
  );

  const repairs: Partial<Record<WarningKind, WarningRepair>> = {};
  if (repaired.padded !== schedule) {
    repairs['unequal-durations'] = {
      label: 'Pad to longest',
      run: () => commitEdit(repaired.padded, 'Pad voices'),
    };
  }
  // No button for a voice with no entries: renumbering can't fix that shape, so the warning row
  // stays without a repair.
  if (repaired.regrouped !== schedule) {
    repairs['gnaural-regroup'] = {
      label: 'Renumber voices',
      run: () => commitEdit(repaired.regrouped, 'Renumber voices'),
    };
  }

  const fitted = useMemo(() => {
    const model = buildChartModel(schedule, lanes, EDITOR_DOMAIN_PADDING);
    return Object.fromEntries(
      model.lanes.map((lane) => [lane.id, lane.domain]),
    ) as Partial<Record<LaneId, readonly [number, number]>>;
  }, [lanes, schedule]);

  const title = schedule.title.trim() || 'Untitled program';
  const wide = useWideLayout();
  const laneHeight = wide
    ? clampLaneHeight(lanes.length, window.innerHeight - STAGE_CHROME_PX)
    : LANE_HEIGHT;

  return (
    <div className="editor">
      <div className="editor__stage">
        <header className="editor__header">
          <button type="button" className="back-link" onClick={() => navigate(LIBRARY)}>
            ← Library
          </button>
          <h1 className="editor__title">{title}</h1>
          <p className="editor__state">{pending ? 'Saving…' : 'Draft — saved automatically'}</p>

          <div className="editor__history">
            <button
              type="button"
              className="button"
              disabled={!editor.canUndo}
              title={editor.undoLabel ? `Undo ${editor.undoLabel.toLowerCase()}` : 'Undo'}
              onClick={editor.undo}
            >
              Undo{editor.undoLabel ? ` ${editor.undoLabel.toLowerCase()}` : ''}
            </button>
            <button
              type="button"
              className="button"
              disabled={!editor.canRedo}
              title={editor.redoLabel ? `Redo ${editor.redoLabel.toLowerCase()}` : 'Redo'}
              onClick={editor.redo}
            >
              Redo{editor.redoLabel ? ` ${editor.redoLabel.toLowerCase()}` : ''}
            </button>
          </div>
        </header>

        <div className="editor__lanes">
          <span className="editor__lanes-label">Lanes</span>
          {ALL_LANES.map((lane) => {
            const on = lanes.includes(lane);
            return (
              <button
                key={lane}
                type="button"
                className={`editor__chip${on ? ' is-active' : ''}`}
                aria-pressed={on}
                // Updater form rather than the rendered `lanes`: two chips pressed inside one
                // frame both read the same closure otherwise, and the second undoes the first.
                onClick={() =>
                  setLanes((current) =>
                    current.includes(lane)
                      ? current.filter((id) => id !== lane)
                      : ALL_LANES.filter((id) => id === lane || current.includes(id)),
                  )
                }
              >
                {LANE_LABELS[lane]}
              </button>
            );
          })}
        </div>

        <details className="editor__options">
          <summary>Drag and axis options</summary>

          {/* There is no modifier key on a phone, so both of these are controls rather than chords.
              On a keyboard Alt overrides the first and Shift the second, momentarily and fixed at
              pointerdown; `EditSurface` handles both. */}
          <label className="editor__check">
            <input
              type="checkbox"
              checked={mode === 'ripple'}
              onChange={(event) => setMode(event.target.checked ? 'ripple' : 'squeeze')}
            />
            <span>Ripple — move everything after the node too</span>
          </label>

          {/* Off by default: the grid follows the zoom, and at 1× on a long programme its step is
              around a hundred times the gap between that document's own nodes, so snapping before
              zooming in would pin whole clusters onto their neighbours. */}
          <label className="editor__check">
            <input
              type="checkbox"
              checked={snap}
              onChange={(event) => setSnap(event.target.checked)}
            />
            <span>Snap to the grid</span>
          </label>

          <LaneRanges
            lanes={lanes}
            labels={LANE_LABELS}
            domains={domains}
            fitted={fitted}
            onChange={setDomains}
          />
        </details>

        {/* The pointer here only ever selects and drags: a tap that lands on nothing clears the
            selection, and the timeline below is what moves the playhead. */}
        <EditSurface
          schedule={schedule}
          lanes={lanes}
          height={Math.max(1, lanes.length) * laneHeight + AXIS_BAND}
          currentTime={player.offset}
          selected={editor.selection}
          mode={mode}
          snap={snap}
          domains={domains}
          marks={marks}
          onSelect={editor.select}
          onCommit={commitEdit}
          onCommitAt={commitEditAt}
          onPreview={preview}
        />

        <Timeline offset={player.offset} duration={player.duration} onSeek={player.seek} />

        <div className="editor__transport">
          {/* Disabled for the same reason the player disables it: twenty minutes of silence with no
              explanation is worse than a button that says it cannot help. The issues list says
              why. */}
          <PlayPauseButton
            playing={player.playing}
            disabled={silent}
            onClick={() => (player.playing ? player.pause() : player.play())}
          />
          <StopButton onClick={player.stop} />
          <VolumeSlider value={masterGain} onChange={onMasterGainChange} />
        </div>

        <Readout schedule={schedule} offset={player.offset} gates={player.voiceGates} />
      </div>

      <div className="editor__aside">
        {/* Never inside a collapsible panel: a problem the document has must not need a click to
            be discovered. */}
        <ValidationPanel
          schedule={warnings}
          entries={issues}
          repairs={repairs}
          onSelect={(node) => editor.select([node])}
        />

        {editor.selection.length > 1 ? (
          <GroupPanel
            schedule={schedule}
            selected={editor.selection}
            mode={mode}
            onCommit={commitEdit}
            onCommitAt={commitEditAt}
          />
        ) : (
          <NodePanel
            schedule={schedule}
            selected={editor.selection[0] ?? null}
            mode={mode}
            onCommit={commitEdit}
            onCommitAt={commitEditAt}
          />
        )}

        <Panel title="Voices" badge={schedule.voices.length} defaultOpen={wide}>
          <VoiceRows schedule={schedule} onCommit={commitEdit} onStructural={commitStructure} />
        </Panel>

        <Panel title="Generate" defaultOpen={false}>
          <AuthoringPanel
            schedule={schedule}
            selected={editor.selection}
            onCommit={commitEdit}
            onCommitAt={commitEditAt}
            onStructural={commitStructure}
          />
        </Panel>

        <Panel title="Program" defaultOpen={false}>
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
          {/* The document's own mix, written into the file — not the listening level above, which
              belongs to whoever is listening. */}
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
        </Panel>

        <Panel title="Finish">
          <p className="editor__publish-note">
            Saving puts a copy in your library, where it can be exported as a WAV or a .gnaural file
            and shared as a link. The draft stays here to keep working on.
          </p>
          <div className="editor__row">
            <button type="button" className="button" onClick={() => onSaveToLibrary(schedule)}>
              Save to library
            </button>
            {/* Asks first, like the library's remove: discarding is the one thing here that undo
                cannot take back. */}
            {discarding ? (
              <>
                <button type="button" className="button" onClick={onDiscard}>
                  Discard for good
                </button>
                <button type="button" className="button" onClick={() => setDiscarding(false)}>
                  Keep working
                </button>
              </>
            ) : (
              <button type="button" className="button" onClick={() => setDiscarding(true)}>
                Discard draft
              </button>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function clampLaneHeight(lanes: number, available: number): number {
  const each = available / Math.max(1, lanes);
  return Math.max(MIN_LANE_HEIGHT, Math.min(LANE_HEIGHT, Math.floor(each)));
}


// null means "no particular lane"; a kind absent here is not drawn on the chart at all.
const MARKED_LANES: Partial<Record<WarningKind, readonly LaneId[] | null>> = {
  'negative-duration': null,
  'base-too-low': ['base'],
  'beat-exceeds-base': ['beat'],
  'volume-out-of-range': ['volumeLeft', 'volumeRight'],
};

// Warnings only — notices (e.g. beat-above-band) mean the document plays exactly as written, and
// marking those would put dots over most of a gamma-band voice for nothing anyone needs to fix.
function chartMarks(issues: EntryWarning[]): ChartMark[] {
  return issues.flatMap((issue) => {
    if (issue.severity !== 'warning' || !(issue.kind in MARKED_LANES)) return [];

    const lanes = MARKED_LANES[issue.kind] ?? null;
    return issue.nodes.map((node) => ({ ...node, lanes, label: issue.message }));
  });
}

// Pushes edits at the running engine without a teardown, skipping edits that can't be heard (a
// reference comparison, since the document is immutable and transforms reuse untouched parts).
// Throttled because a transition is ~70ms wide and calling faster cancels the previous ramp before
// it lands — held-down undo is the surface here that can outrun it.
function usePlaybackOfEdits(
  player: Player,
  initial: Schedule,
  schedule: Schedule,
  voiceMap: VoiceMap | null,
): { preview: (next: Schedule) => void } {
  const pushed = useRef(initial);
  // The map from the document last pushed to the one about to be. Must accumulate rather than just
  // hold the latest: the throttle below keeps only the most recent action, so two structural
  // commits inside one interval (e.g. held-down undo across a reorder) would otherwise deliver a
  // map describing only the second half of the journey, misplacing the session gates.
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

  // A drag never makes a voice map itself, but it can begin inside the throttle window of a
  // structural commit that hasn't gone out yet — so it still has to carry and clear any pending
  // map, or it would apply this document to gates the previous edit hasn't finished moving.
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

/** Where each selected node's voice ended up. A voice the edit deleted takes its nodes with it. */
function followVoices(selection: Selection, map: VoiceMap): Selection {
  return selection.flatMap((node) => {
    const voice = map[node.voice];
    return voice === undefined || voice < 0 ? [] : [{ voice, entry: node.entry }];
  });
}

function affectsAudio(previous: Schedule, next: Schedule): boolean {
  return (
    previous.voices !== next.voices ||
    previous.masterVolume !== next.masterVolume ||
    previous.stereoSwap !== next.stereoSwap ||
    previous.loops !== next.loops
  );
}

// Skipped inside a text field: the browser's own undo is the better answer there, since it works
// on characters not yet committed to the document.
function useUndoShortcuts(undo: () => void, redo: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey)) return;
      if (isTypingTarget(event.target)) return;

      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [redo, undo]);
}
