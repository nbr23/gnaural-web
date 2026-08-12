import { useState } from 'react';
import type { EntryWarning, ScheduleWarning } from '../document/warnings';
import type { NodeRef } from './history';

export interface ValidationPanelProps {
  /** Schedule-scoped, from `scheduleWarnings`: unsupported types, §3.7's raggedness, nothing to play. */
  schedule: ScheduleWarning[];
  /** Value-scoped, from `entryWarnings`: §6.1's own list, each one locatable. */
  entries: EntryWarning[];
  onSelect(node: NodeRef): void;
}

/**
 * §6.1's "validation with inline warnings, not hard errors", as one surface.
 *
 * **Its own component rather than a configured `player/WarningList`**, the same reasoning that gave
 * `VoiceRows` and Live mode theirs: these rows carry an action — go to the node — that the player's
 * list can never have, because a program there is not editable. What is deliberately shared with it
 * is the *shape*: 9a's two tiers, warnings in amber outright and notices folded away, because the
 * severity split is what lets §6.1's 40 Hz beat rule ship against four presets that exceed it.
 *
 * **Nothing here blocks anything.** §6.1 says inline warnings rather than hard errors, and the two
 * states that genuinely corrupt a file are already refusals at the point of the edit (a voice cannot
 * be emptied) or a warned, allowed state 9a settled (a schedule with no voices). Save, export and
 * share are untouched.
 *
 * It renders nothing at all for a clean document, which is every bundled program.
 */
export function ValidationPanel({ schedule, entries, onSelect }: ValidationPanelProps) {
  const all = [...schedule, ...entries];
  const alerts = all.filter((warning) => warning.severity === 'warning');
  const notices = all.filter((warning) => warning.severity === 'notice');

  if (all.length === 0) return null;

  return (
    <section className="validation">
      {alerts.length > 0 && (
        <ul className="validation__list" role="alert">
          {alerts.map((warning, index) => (
            <Row key={`${warning.kind}-${index}`} warning={warning} onSelect={onSelect} />
          ))}
        </ul>
      )}

      {notices.length > 0 && (
        <details className="validation__notices">
          <summary>
            {notices.length === 1 ? 'One note about this program' : `${notices.length} notes about this program`}
          </summary>
          <ul className="validation__list">
            {notices.map((warning, index) => (
              <Row key={`${warning.kind}-${index}`} warning={warning} onSelect={onSelect} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * One rule, however many nodes tripped it.
 *
 * A row per node would have made a gamma-band programme fifteen rows of the same sentence, so the
 * count is in the sentence and **Show** walks the offenders one press at a time — which is also the
 * only way to reach the ones the chart cannot draw a mark for, since notices are not marked.
 */
function Row({
  warning,
  onSelect,
}: {
  warning: ScheduleWarning | EntryWarning;
  onSelect(node: NodeRef): void;
}) {
  const nodes = 'nodes' in warning ? warning.nodes : [];
  const [shown, setShown] = useState(0);
  const index = nodes.length > 0 ? shown % nodes.length : 0;

  return (
    <li className="validation__item">
      <span>{warning.message}</span>
      {nodes.length > 0 && (
        <button
          type="button"
          className="validation__show"
          onClick={() => {
            onSelect(nodes[index]);
            setShown(shown + 1);
          }}
        >
          {nodes.length === 1 ? 'Show' : `Show (${index + 1} of ${nodes.length})`}
        </button>
      )}
    </li>
  );
}
