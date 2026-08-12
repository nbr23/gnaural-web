import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { moveVoice, removeEntry, removeVoice, updateSchedule } from '../document/edit';
import type { Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { renderHook } from '../test-utils';
import { useEditor } from './useEditor';

/** Two voices of four entries, so a selection in these tests points at something real. */
function schedule(title: string): Schedule {
  const voice = (id: number): Voice => ({
    id,
    description: `Voice ${id + 1}`,
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries: Array.from({ length: 4 }, () => ({
      duration: 150,
      baseFreq: 200,
      beatFreq: 10,
      volumeLeft: 0.5,
      volumeRight: 0.5,
      preserved: {},
    })),
    preserved: {},
  });

  return {
    title,
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices: [voice(0), voice(1)],
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

  it('publishes a structural commit voice map, and its inverse on undo', () => {
    const hook = renderHook(() => useEditor(schedule('one')));

    expect(hook.current.voiceMap).toBeNull();

    act(() => {
      const edit = moveVoice(hook.current.document, { from: 0, to: 1 });
      hook.current.commit(edit.schedule, { label: 'Move voice', voiceMap: edit.voiceMap });
    });
    expect(hook.current.voiceMap).toEqual([1, 0]);

    act(() => hook.current.undo());
    expect(hook.current.voiceMap).toEqual([1, 0]);

    act(() => hook.current.redo());
    expect(hook.current.voiceMap).toEqual([1, 0]);

    hook.unmount();
  });

  it('leaves the map null for an edit that moved no voice', () => {
    const hook = renderHook(() => useEditor(schedule('one')));

    act(() => {
      const edit = removeVoice(hook.current.document, 0);
      hook.current.commit(edit.schedule, { label: 'Delete voice', voiceMap: edit.voiceMap });
    });
    expect(hook.current.voiceMap).toEqual([-1, 0]);

    act(() => {
      hook.current.commit(updateSchedule(hook.current.document, { title: 'two' }), {
        label: 'Rename program',
      });
    });
    expect(hook.current.voiceMap).toBeNull();

    hook.unmount();
  });

  /**
   * Redo restores the selection the commit was made *with* — a pre-edit selection landing in a
   * post-edit document. Harmless while every edit was a value edit; after a reorder it points at
   * the voice that used to be there.
   */
  it('carries a restored selection across a structural redo', () => {
    const hook = renderHook(() => useEditor(schedule('one')));

    act(() => hook.current.select({ voice: 0, entry: 2 }));
    act(() => {
      const edit = moveVoice(hook.current.document, { from: 0, to: 1 });
      hook.current.commit(edit.schedule, { label: 'Move voice', voiceMap: edit.voiceMap });
    });

    act(() => hook.current.undo());
    expect(hook.current.selection).toEqual({ voice: 0, entry: 2 });

    act(() => hook.current.redo());
    expect(hook.current.selection).toEqual({ voice: 1, entry: 2 });

    hook.unmount();
  });

  it('drops a restored selection whose voice the commit deleted', () => {
    const hook = renderHook(() => useEditor(schedule('one')));

    act(() => hook.current.select({ voice: 0, entry: 1 }));
    act(() => {
      const edit = removeVoice(hook.current.document, 0);
      hook.current.commit(edit.schedule, { label: 'Delete voice', voiceMap: edit.voiceMap });
    });

    act(() => hook.current.undo());
    expect(hook.current.selection).toEqual({ voice: 0, entry: 1 });

    act(() => hook.current.redo());
    expect(hook.current.selection).toBeNull();

    hook.unmount();
  });

  /**
   * The backstop: a pair of indices must never outlive the document it addressed. An entry index is
   * clamped rather than dropped, because the node one along is the useful place to be.
   */
  it('clamps a restored selection that points past the end of its voice', () => {
    const hook = renderHook(() => useEditor(schedule('one')));

    act(() => hook.current.select({ voice: 0, entry: 3 }));
    act(() => {
      hook.current.commit(removeEntry(hook.current.document, { voice: 0, entry: 0 }), {
        label: 'Delete node',
      });
    });

    act(() => hook.current.undo());
    expect(hook.current.selection).toEqual({ voice: 0, entry: 3 });

    act(() => hook.current.redo());
    expect(hook.current.selection).toEqual({ voice: 0, entry: 2 });

    hook.unmount();
  });
});
