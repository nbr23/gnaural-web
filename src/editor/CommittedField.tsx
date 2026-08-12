import type { ChangeEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

export interface CommittedFieldProps {
  label: string;
  value: string;
  multiline?: boolean;
  numeric?: boolean;
  /** For a derived value that is shown for completeness rather than edited. */
  readOnly?: boolean;
  /** Shown under the field — what the value means, when the number alone does not say it. */
  hint?: string;
  onCommit(value: string): void;
}

/**
 * A text field that edits locally and commits once, when it is left.
 *
 * **Blur is the text equivalent of pointerup.** Committing every keystroke would make undo walk
 * back through a title one character at a time, which is not what anyone means by undo; and the
 * alternative — coalescing commits that arrive close together — needs a rule about how close, where
 * blur is unambiguous. It is the same decision the command stack makes about drags: the gesture is
 * the caller's business, and the stack sees one commit at the end of it.
 *
 * The in-flight text lives here for the same reason Live mode's slider values live in `LiveView`:
 * a keystroke that re-rendered the whole editor would be `StaticPlot`'s defect in a new place.
 */
export function CommittedField({
  label,
  value,
  multiline,
  numeric,
  readOnly,
  hint,
  onCommit,
}: CommittedFieldProps) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);

  // An undo, a redo or a save can change the document under a field nobody is typing in.
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  const commit = () => {
    editing.current = false;
    if (draft !== value) onCommit(draft);
  };

  const shared = {
    value: draft,
    readOnly,
    onFocus: () => {
      editing.current = true;
    },
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(event.target.value),
    onBlur: commit,
  };

  return (
    <label className="editor__field">
      <span className="editor__field-label">{label}</span>
      {multiline ? (
        <textarea rows={3} {...shared} />
      ) : (
        <input
          type={numeric ? 'number' : 'text'}
          inputMode={numeric ? 'decimal' : undefined}
          step={numeric ? 'any' : undefined}
          {...shared}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      )}
      {hint && <span className="editor__field-hint">{hint}</span>}
    </label>
  );
}
