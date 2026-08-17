import type { ReactNode } from 'react';
import { useState } from 'react';
import './Panel.css';

export interface PanelProps {
  title: string;
  /** A count or a status shown beside the title, for what a closed panel would otherwise hide. */
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A collapsible section of secondary controls, shared by the player and the editor.
 *
 * `<details>` rather than conditional rendering, so a closed panel keeps its contents in the DOM
 * for find-in-page.
 */
export function Panel({ title, badge, defaultOpen = true, children }: PanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      className="panel"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="panel__summary">
        <span className="panel__title">{title}</span>
        {badge !== undefined && <span className="panel__badge">{badge}</span>}
      </summary>
      <div className="panel__body">{children}</div>
    </details>
  );
}
