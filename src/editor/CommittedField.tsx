import type { ChangeEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

export interface CommittedFieldProps {
  label: string;
  labelHidden?: boolean;
  value: string;
  multiline?: boolean;
  numeric?: boolean;
  readOnly?: boolean;
  hint?: string;
  onCommit(value: string): void;
}

// Commits on blur rather than on every keystroke, so undo doesn't walk back through a title one
// character at a time. Draft text is kept local rather than lifted, to avoid re-rendering the
// whole editor per keystroke.
export function CommittedField({
  label,
  labelHidden,
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
      <span className={labelHidden ? 'visually-hidden' : 'editor__field-label'}>{label}</span>
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
