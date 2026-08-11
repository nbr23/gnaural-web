import { describe, expect, it, vi } from 'vitest';
import { updateSchedule } from '../document/edit';
import type { Schedule } from '../document/types';
import { HistoryStack } from './history';

/** The stack only ever compares and stores documents, so the thinnest possible one will do. */
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

function titled(stack: HistoryStack, title: string): void {
  stack.commit(updateSchedule(stack.present, { title }), { label: `Rename to ${title}` });
}

describe('HistoryStack', () => {
  it('starts at the opening document with nothing to undo', () => {
    const stack = new HistoryStack(schedule('one'));

    expect(stack.present.title).toBe('one');
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
    expect(stack.undoLabel).toBeNull();
    expect(stack.presentMeta).toBeNull();
  });

  it('walks back and forward through commits', () => {
    const stack = new HistoryStack(schedule('one'));
    titled(stack, 'two');
    titled(stack, 'three');

    expect(stack.present.title).toBe('three');
    expect(stack.undoLabel).toBe('Rename to three');

    stack.undo();
    expect(stack.present.title).toBe('two');
    expect(stack.canRedo).toBe(true);
    expect(stack.redoLabel).toBe('Rename to three');

    stack.undo();
    expect(stack.present.title).toBe('one');
    expect(stack.canUndo).toBe(false);

    stack.redo();
    stack.redo();
    expect(stack.present.title).toBe('three');
    expect(stack.canRedo).toBe(false);
  });

  it('undo and redo at the ends do nothing', () => {
    const stack = new HistoryStack(schedule('one'));
    stack.undo();
    stack.redo();
    expect(stack.present.title).toBe('one');
    expect(stack.version).toBe(0);
  });

  it('drops the redo tail when something is committed after an undo', () => {
    const stack = new HistoryStack(schedule('one'));
    titled(stack, 'two');
    titled(stack, 'three');
    stack.undo();
    titled(stack, 'elsewhere');

    expect(stack.canRedo).toBe(false);
    stack.undo();
    expect(stack.present.title).toBe('two');
    stack.redo();
    expect(stack.present.title).toBe('elsewhere');
  });

  /**
   * A no-op edit must not push a step. `updateSchedule` returns its input unchanged when the patch
   * changes nothing, and the stack takes that identity as the answer.
   */
  it('ignores a commit of the document already present', () => {
    const stack = new HistoryStack(schedule('one'));
    titled(stack, 'two');
    titled(stack, 'two');

    expect(stack.version).toBe(1);
    stack.undo();
    expect(stack.present.title).toBe('one');
  });

  it('drops the oldest documents past the limit rather than refusing the edit', () => {
    const stack = new HistoryStack(schedule('one'), 3);
    titled(stack, 'two');
    titled(stack, 'three');
    titled(stack, 'four');

    expect(stack.present.title).toBe('four');
    stack.undo();
    stack.undo();
    expect(stack.canUndo).toBe(false);
    // 'one' fell off the bottom; the session keeps going from what is left.
    expect(stack.present.title).toBe('two');
  });

  it('carries the selection of the commit that made the present', () => {
    const stack = new HistoryStack(schedule('one'));
    const selection = [{ voice: 0, entry: 3 }];
    stack.commit(schedule('two'), { label: 'Delete node', selection });

    expect(stack.presentMeta?.selection).toBe(selection);
    stack.undo();
    expect(stack.presentMeta).toBeNull();
  });

  it('notifies subscribers on every change and stops when unsubscribed', () => {
    const stack = new HistoryStack(schedule('one'));
    const listener = vi.fn();
    const unsubscribe = stack.subscribe(listener);

    titled(stack, 'two');
    stack.undo();
    stack.redo();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(stack.version).toBe(3);

    unsubscribe();
    titled(stack, 'three');
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
