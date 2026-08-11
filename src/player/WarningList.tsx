import type { ScheduleWarning } from '../document/warnings';
import './WarningList.css';

export interface WarningListProps {
  warnings: ScheduleWarning[];
}

/**
 * What this file does that its author may not have meant (PLAN.md §3.3, §3.4, §3.7).
 *
 * Two tiers, because they are two different statements. **Warnings** — a silent voice, a schedule
 * cut short — mean what you hear differs from what the file describes, and are shown outright.
 * **Notices** mean the file was unusual and was read correctly anyway, and sit behind a
 * disclosure: `powernap.gnaural` declaring three voices against its one is the canonical case, and
 * it deserves an answer to "did it read my file properly?" rather than an alarm.
 *
 * Almost every program shows nothing here at all, which is the intended resting state — this is a
 * surface for imported files, not decoration for the bundled ones.
 */
export function WarningList({ warnings }: WarningListProps) {
  const alerts = warnings.filter((warning) => warning.severity === 'warning');
  const notices = warnings.filter((warning) => warning.severity === 'notice');

  if (warnings.length === 0) return null;

  return (
    <div className="warnings">
      {alerts.length > 0 && (
        <ul className="warnings__list" role="alert">
          {alerts.map((warning, index) => (
            <li className="warnings__item" key={`${warning.kind}-${index}`}>
              {warning.message}
            </li>
          ))}
        </ul>
      )}

      {notices.length > 0 && (
        <details className="warnings__notices">
          <summary>
            {notices.length === 1 ? 'One note about this file' : `${notices.length} notes about this file`}
          </summary>
          <ul className="warnings__list">
            {notices.map((notice, index) => (
              <li className="warnings__item" key={`${notice.kind}-${index}`}>
                {notice.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
