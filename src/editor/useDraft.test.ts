import { beforeEach, describe, expect, it } from 'vitest';
import { updateSchedule } from '../document/edit';
import { parseSchedule } from '../document/parser';
import { loadFixture } from '../document/test-fixtures';
import type { Schedule } from '../document/types';
import { createDraft, getDraft } from '../library/storage';
import { resetDatabase } from '../test-setup';
import { flush, renderHook, wait } from '../test-utils';
import { useDraft } from './useDraft';

const POWERNAP = loadFixture('powernap.gnaural');
const INTERVAL = 20;

beforeEach(resetDatabase);

async function openDraft() {
  const schedule = parseSchedule(POWERNAP);
  const draft = await createDraft('Power Nap', POWERNAP, schedule);
  return { draft, schedule };
}

describe('useDraft', () => {
  it('writes nothing while the document is untouched', async () => {
    const { draft, schedule } = await openDraft();
    const hook = renderHook(() => useDraft(draft.id, schedule, INTERVAL));

    await wait(INTERVAL * 2);
    await flush();

    expect(hook.current.pending).toBe(false);
    expect((await getDraft(draft.id))?.updatedAt).toBe(draft.updatedAt);
    hook.unmount();
  });

  it('saves an edited document after the debounce', async () => {
    const { draft, schedule } = await openDraft();
    let document: Schedule = schedule;
    const hook = renderHook(() => useDraft(draft.id, document, INTERVAL));

    document = updateSchedule(schedule, { title: 'Nap, shorter' });
    hook.rerender();
    expect(hook.current.pending).toBe(true);

    await wait(INTERVAL * 2);
    await flush();

    expect(hook.current.pending).toBe(false);
    const saved = await getDraft(draft.id);
    expect(saved?.title).toBe('Nap, shorter');
    expect(parseSchedule(saved?.xml ?? '').title).toBe('Nap, shorter');
    hook.unmount();
  });

  /** Leaving the editor a moment after typing is the ordinary case, not an edge one. */
  it('flushes a pending write on unmount', async () => {
    const { draft, schedule } = await openDraft();
    let document: Schedule = schedule;
    const hook = renderHook(() => useDraft(draft.id, document, INTERVAL));

    document = updateSchedule(schedule, { title: 'Left in a hurry' });
    hook.rerender();
    hook.unmount();
    await flush();

    expect((await getDraft(draft.id))?.title).toBe('Left in a hurry');
  });

  it('collapses a burst of edits into one write', async () => {
    const { draft, schedule } = await openDraft();
    let document: Schedule = schedule;
    const hook = renderHook(() => useDraft(draft.id, document, INTERVAL));

    for (const title of ['N', 'Na', 'Nap']) {
      document = updateSchedule(schedule, { title });
      hook.rerender();
    }

    await wait(INTERVAL * 2);
    await flush();

    const saved = await getDraft(draft.id);
    expect(saved?.title).toBe('Nap');
    // One write, so one timestamp: the intermediate documents never reached the database.
    expect(saved?.updatedAt).toBeGreaterThan(draft.updatedAt);
    hook.unmount();
  });
});
