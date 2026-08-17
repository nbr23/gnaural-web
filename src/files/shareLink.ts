import { parseSchedule } from '../document/parser';
import { serializeSchedule } from '../document/serializer';
import type { Schedule } from '../document/types';

/**
 * A whole program in a URL, with no server involved. The payload is the serialized `.gnaural`
 * deflated and base64url'd into the **fragment** — never sent to the server, so a shared link stays
 * local-first. `.gnaural` XML is repetitive enough that deflate is dramatic, but `MAX_SHARE_PAYLOAD`
 * is still needed: four of Gnaural's own presets exceed it (`hypnagogic-gale` at 10,080 entries is
 * the extreme), and `useExport` falls back to exporting the file for those.
 */

/** Fall back to file export past this size, measured in fragment characters. */
export const MAX_SHARE_PAYLOAD = 8192;

export class ShareTooLargeError extends Error {
  constructor(readonly length: number) {
    super('This program is too large to share as a link.');
    this.name = 'ShareTooLargeError';
  }
}

export async function encodeSharePayload(schedule: Schedule): Promise<string> {
  const deflated = await pipe(
    new TextEncoder().encode(serializeSchedule(schedule)),
    new CompressionStream('deflate-raw'),
  );

  const payload = toBase64Url(deflated);
  if (payload.length > MAX_SHARE_PAYLOAD) throw new ShareTooLargeError(payload.length);
  return payload;
}

export async function decodeSharePayload(payload: string): Promise<Schedule> {
  const inflated = await pipe(fromBase64Url(payload), new DecompressionStream('deflate-raw'));
  return parseSchedule(new TextDecoder().decode(inflated));
}

/** The absolute URL to hand to `navigator.share` or the clipboard. */
export function shareUrl(payload: string): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${search}#/s/${payload}`;
}

async function pipe(bytes: Uint8Array, through: CompressionStream | DecompressionStream) {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(through);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** base64url — `+/` become `-_` and the padding goes, so the payload drops into a fragment verbatim. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked because `String.fromCharCode(...bytes)` blows the argument limit on a large payload.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(payload: string): Uint8Array {
  const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
