import { BUILD_ID } from '../app/debug';
import type { Player } from './usePlayer';

/**
 * What this device is actually doing, shown behind `?debug=1`.
 *
 * **Temporary.** It exists to size the transport scheduling lookahead against a real phone's
 * output buffer rather than against a guess, and to make it obvious which build is running when a
 * service worker may be serving a previous one. Delete it with the rest of `src/app/debug.ts`.
 */
export function Diagnostics({ player }: { player: Player }) {
  const { sampleRate, baseLatency, outputLatency, state, lookahead } = player.diagnostics();

  return (
    <dl className="diagnostics">
      <Row label="build" value={BUILD_ID} />
      <Row label="state" value={state ?? 'no context yet — press play'} />
      <Row label="sampleRate" value={sampleRate === null ? '—' : `${sampleRate} Hz`} />
      <Row label="baseLatency" value={milliseconds(baseLatency)} />
      <Row label="outputLatency" value={milliseconds(outputLatency)} />
      <Row label="lookahead" value={milliseconds(lookahead)} />
    </dl>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function milliseconds(seconds: number | null): string {
  return seconds === null ? '—' : `${(seconds * 1000).toFixed(1)} ms`;
}
