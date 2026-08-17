import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from '../app/Panel';
import { numberOr } from '../app/format';
import { LIBRARY, navigate } from '../app/routing';
import { isTypingTarget } from '../app/useKeyboardShortcuts';
import { useCoarsePointer, useWideLayout } from '../app/useMediaQuery';
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

/**
 * Lane heights, chosen so four lanes are usable rather than four times a quarter of a fixed box.
 *
 * §6.1 asks for independently collapsible lanes and this is why it could not wait for step 8: the
 * chart divides its total height between however many lanes it is given, so beat, base and both
 * volumes inside the read-only 280 px leaves about 44 px of plot each — unusable before it is
 * unzoomable.
 *
 * `MIN` is what the fourth lane is allowed to shrink to when the chart has to fit a sticky column
 * beside the panels: still twice the 44 px that made a fixed box unusable, and the lane toggles are
 * one press away from giving any lane its full height back.
 */
const LANE_HEIGHT = 116;
const MIN_LANE_HEIGHT = 90;
const AXIS_BAND = 30;
/**
 * Everything in the stage that is not the plot: header, lane chips, the options summary, the
 * readout, the timeline, the transport, the volume, and the gaps between them.
 *
 * Measured in the browser at 1280×900 rather than added up from the stylesheet, which is why it is
 * a round 480 and not a sum. It only has to be close: it decides how much of the remaining height
 * each lane may take, and being wrong by a little costs a little scrolling on a four-lane document
 * in a short window.
 */
const STAGE_CHROME_PX = 480;

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

  // Session state, deliberately outside the history stack: which lanes are open, how a drag treats
  // the following segment, whether it snaps, and what each axis covers are all properties of the
  // person editing rather than of the document. The view window itself lives one level further down,
  // in `EditSurface`, because it changes at pointer rate.
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

  /**
   * An edit that shifts entry indices. The commit records the selection it *had* (undo restores
   * that); this sets where the selection lands *after* it, which only the command knows.
   */
  const commitEditAt = useCallback(
    (next: Schedule, label: string, selection: Selection) => {
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
      if (selection !== undefined) editor.select(selection ? [selection] : []);
      else editor.select(followVoices(current, edit.voiceMap));
    },
    [editor],
  );

  const { preview } = usePlaybackOfEdits(player, initial, schedule, editor.voiceMap);
  useUndoShortcuts(editor.undo, editor.redo);

  /**
   * §6.1's validation, over the **committed** document.
   *
   * That is not a discipline anyone has to keep: the in-flight document of a drag never leaves
   * `EditSurface`, so `schedule` here is by construction the last thing decided, and these memos
   * hold for the whole of a gesture. `marks` in particular must, because the chart draws them from a
   * `memo`'d layer.
   */
  const warnings = useMemo(() => scheduleWarnings(schedule), [schedule]);
  const issues = useMemo(() => entryWarnings(schedule), [schedule]);
  const marks = useMemo(() => chartMarks(issues), [issues]);
  const silent = warnings.some((warning) => warning.kind === 'nothing-to-play');

  /**
   * What each lane's axis would cover if nobody overrode it — what the range fields show, and what
   * they start from when one is first typed into.
   *
   * The same call the chart makes, on the same arguments, so the two cannot disagree; it costs
   * 0.04 ms on the densest bundled document and runs once per commit, not per frame.
   */
  /**
   * The two one-click repairs (§3.7's "pad to longest", and the reopen-in-Gnaural hazard step 7
   * detected and deferred), offered on the row that states the problem.
   *
   * **Each is offered only when it would change something**, which is a real distinction rather
   * than a guard: `gnaural-regroup` is also raised for a voice with no entries, and renumbering
   * cannot help that shape — the voice contributes no datapoint whatever its id. That row keeps its
   * warning and gets no button, and the voice list carries the two answers it does have.
   *
   * Memoised on the document alone, like the warnings above and for the same reason: this view
   * re-renders on every playhead tick, and running both transforms ten times a second to find out
   * whether a button should be there is the kind of work this project has already paid to remove
   * once. The offer objects themselves are rebuilt per render, which costs nothing — the panel is
   * not memoised and re-renders anyway.
   */
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
  const coarse = useCoarsePointer();
  const wide = useWideLayout();
  const laneHeight = wide
    ? clampLaneHeight(lanes.length, window.innerHeight - STAGE_CHROME_PX)
    : LANE_HEIGHT;

  return (
    <div className="editor">
      {/* The document, and everything that acts on the document as a whole. The chart is the third
          element on the page rather than the ninth: the browser pass measured it 622 px down on a
          phone, which is below the fold on the device this app is mostly used on. */}
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

        {/* Chips rather than checkboxes: four lanes, one row, at a thumb's size — the checkbox
            version wrapped onto three lines on a phone and pushed the chart down with it. */}
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

        {/* No seek on a miss on touch, for the reason the player drops it there: a tap that lands
            on nothing should clear the selection, not move the playhead. */}
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
          onSeek={coarse ? undefined : player.seek}
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
          {/* The timeline above already says where the playhead is, against the length it is a
              fraction of. Volume takes the space, as it does in the player. */}
          <VolumeSlider value={masterGain} onChange={onMasterGainChange} />
        </div>

        {/* Below the transport, as in the player: the plot above already draws these curves, and
            what the beat is *this second* is a thing to glance down at, not to sit under the
            chart pushing the controls further away. */}
        <Readout schedule={schedule} offset={player.offset} gates={player.voiceGates} />
      </div>

      <div className="editor__aside">
        {/* Never inside a panel: the marks these rows explain are already on the chart, and a
            problem the document has must not need a click to be discovered. */}
        <ValidationPanel
          schedule={warnings}
          entries={issues}
          repairs={repairs}
          onSelect={(node) => editor.select([node])}
        />

        {/* Exact values are what §6.1 asks for and they only mean something for one node; with a
            marquee's worth selected, what generalises is the operation rather than the value.
            Never folded away: this panel *is* the selection, and its own heading says which. */}
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

        {/* §6.1's authoring aids. Voice- and document-scoped, so they sit with the voice list
            rather than with the node and group panels, which are what a selection means. */}
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

/**
 * How tall each lane may be when the stage has to fit beside the panels rather than scroll.
 *
 * Four open lanes at the full 116 px plus the axis and the chrome around it is taller than a
 * laptop's viewport, and a sticky column taller than the viewport does not stick — it scrolls like
 * anything else, which is precisely the behaviour the two-column layout exists to avoid.
 */
function clampLaneHeight(lanes: number, available: number): number {
  const each = available / Math.max(1, lanes);
  return Math.max(MIN_LANE_HEIGHT, Math.min(LANE_HEIGHT, Math.floor(each)));
}


/**
 * Which lane each rule is about. `null` is "no particular lane" — a duration is not a value in one
 * of them — and a kind that is absent here is not drawn on the chart at all.
 *
 * A presentation decision, so it lives here rather than in `src/document/`, which knows nothing
 * about lanes.
 */
const MARKED_LANES: Partial<Record<WarningKind, readonly LaneId[] | null>> = {
  'negative-duration': null,
  'base-too-low': ['base'],
  'beat-exceeds-base': ['beat'],
  // Either channel can be the offender and the rule does not say which, so both lanes carry it.
  'volume-out-of-range': ['volumeLeft', 'volumeRight'],
};

/**
 * Marks for the chart — **warnings only**.
 *
 * A notice is the document being unusual and playing exactly as written, and four of the nineteen
 * bundled programmes carry one: `beat-above-band`, at fifteen entries between them. Marking those
 * would put dots over most of a gamma-band voice for something nobody needs to fix. They keep their
 * row in the panel, which is where a notice belongs.
 */
function chartMarks(issues: EntryWarning[]): ChartMark[] {
  return issues.flatMap((issue) => {
    if (issue.severity !== 'warning' || !(issue.kind in MARKED_LANES)) return [];

    const lanes = MARKED_LANES[issue.kind] ?? null;
    return issue.nodes.map((node) => ({ ...node, lanes, label: issue.message }));
  });
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
      if (isTypingTarget(event.target)) return;

      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [redo, undo]);
}
