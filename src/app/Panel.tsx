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
 * Both views had grown a flat stack of everything at once — the browser pass measured the editor at
 * 5994 px of page on a phone — and the answer in both is the same: the thing being listened to or
 * edited stays put, and everything about it folds away. `<details>` rather than conditional
 * rendering, so a closed panel keeps its contents in the DOM for find-in-page and needs no ARIA of
 * ours.
 *
 * **Warnings never live in one of these.** A file that will not play the way it reads has to say so
 * without being opened.
 */
export function Panel({ title, badge, defaultOpen = true, children }: PanelProps) {
  // State rather than the bare attribute: the views around this re-render ten times a second while
  // playing, and an `open` React thinks it owns but never updates is the kind of thing that works
  // until someone adds a key to a parent.
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
