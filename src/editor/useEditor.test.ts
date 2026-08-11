import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { updateSchedule } from '../document/edit';
import type { Schedule } from '../document/types';
import { renderHook } from '../test-utils';
import { useEditor } from './useEditor';

function schedule(title: string): Schedule {
  return {
    title,
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices: [],
    preserved: {},
  };
}

describe('useEditor', () => {
  it('publishes the committed document and re-renders on every navigation', () => {
    const hook = renderHook(() => useEditor(schedule('one')));

    act(() => {
      hook.current.commit(updateSchedule(hook.current.document, { title: 'two' }), {
        label: 'Rename program',
      });
    });
    expect(hook.current.document.title).toBe('two');
    expect(hook.current.canUndo).toBe(true);
    expect(hook.current.undoLabel).toBe('Rename program');

    act(() => hook.current.undo());
    expect(hook.current.document.title).toBe('one');
    expect(hook.current.canRedo).toBe(true);

    act(() => hook.current.redo());
    expect(hook.current.document.title).toBe('two');

    hook.unmount();
  });

  /** A commit that changes nothing must not leave an undo step behind. */
  it('ignores a commit of the document already present', () => {
    const hook = renderHook(() => useEditor(schedule('one')));

    act(() => {
      hook.current.commit(updateSchedule(hook.current.document, { title: 'one' }), {
        label: 'Rename program',
      });
    });

    expect(hook.current.canUndo).toBe(false);
    hook.unmount();
  });

  /** The editor owns the document after it opens; a new one is a new editor, not a merge. */
  it('reads the initial document once', () => {
    let initial = schedule('one');
    const hook = renderHook(() => useEditor(initial));

    initial = schedule('something else');
    hook.rerender();

    expect(hook.current.document.title).toBe('one');
    hook.unmount();
  });
});
