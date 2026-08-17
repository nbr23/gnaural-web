import { useState } from 'react';
import type { EntryWarning, ScheduleWarning, WarningKind } from '../document/warnings';
import type { NodeRef } from './history';

export interface WarningRepair {
  label: string;
  run(): void;
}

export interface ValidationPanelProps {
  schedule: ScheduleWarning[];
  entries: EntryWarning[];
  // Keyed by rule, since a repair fixes the rule rather than one of the nodes that tripped it.
  repairs?: Partial<Record<WarningKind, WarningRepair>>;
  onSelect(node: NodeRef): void;
}

// Its own component rather than a configured player/WarningList: these rows carry a "go to the
// node" action the read-only player list can never have. Renders nothing for a clean document.
export function ValidationPanel({ schedule, entries, repairs, onSelect }: ValidationPanelProps) {
  const all = [...schedule, ...entries];
  const alerts = all.filter((warning) => warning.severity === 'warning');
  const notices = all.filter((warning) => warning.severity === 'notice');

  if (all.length === 0) return null;

  return (
    <section className="validation">
      {alerts.length > 0 && (
        <ul className="validation__list" role="alert">
          {alerts.map((warning, index) => (
            <Row
              key={`${warning.kind}-${index}`}
              warning={warning}
              repair={repairs?.[warning.kind]}
              onSelect={onSelect}
            />
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
              <Row
                key={`${warning.kind}-${index}`}
                warning={warning}
                repair={repairs?.[warning.kind]}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// One row per rule rather than per node — the count is in the sentence, and Show walks the
// offenders one press at a time.
function Row({
  warning,
  repair,
  onSelect,
}: {
  warning: ScheduleWarning | EntryWarning;
  repair?: WarningRepair;
  onSelect(node: NodeRef): void;
}) {
  const nodes = 'nodes' in warning ? warning.nodes : [];
  const [shown, setShown] = useState(0);
  const index = nodes.length > 0 ? shown % nodes.length : 0;

  return (
    <li className="validation__item">
      <span>{warning.message}</span>
      {repair && (
        <button type="button" className="validation__show validation__fix" onClick={repair.run}>
          {repair.label}
        </button>
      )}
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
