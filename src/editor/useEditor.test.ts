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

  /**
   * §6.1 wants undo to restore what was selected, so undoing a move puts the node back *and* leaves
   * it selected — otherwise the obvious next action, trying again, needs a re-select first.
   */
  it('carries the selection with a commit and restores it on undo and redo', () => {
    const hook = renderHook(() => useEditor(schedule('one')));

    act(() => hook.current.select({ voice: 0, entry: 3 }));
    expect(hook.current.selection).toEqual({ voice: 0, entry: 3 });

    act(() => {
      hook.current.commit(updateSchedule(hook.current.document, { title: 'two' }), {
        label: 'Move node',
      });
    });

    act(() => hook.current.select({ voice: 1, entry: 0 }));
    act(() => hook.current.undo());
    // The commit's own selection, not the opening document's absence of one: undoing an edit and
    // finding the node deselected is exactly wrong when the next action is to try again.
    expect(hook.current.selection).toEqual({ voice: 0, entry: 3 });

    act(() => hook.current.redo());
    expect(hook.current.selection).toEqual({ voice: 0, entry: 3 });

    hook.unmount();
  });

  /** Selection is session state: it is recorded by commits, never a reason for one. */
  it('never pushes a commit for a selection change', () => {
    const hook = renderHook(() => useEditor(schedule('one')));

    act(() => hook.current.select({ voice: 0, entry: 1 }));
    act(() => hook.current.select(null));

    expect(hook.current.canUndo).toBe(false);
    hook.unmount();
  });
});
