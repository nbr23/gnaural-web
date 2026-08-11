import { parseSchedule } from '../document/parser';
import { serializeSchedule } from '../document/serializer';
import type { Schedule } from '../document/types';

/**
 * A whole program in a URL, with no server involved (PLAN.md §5.1).
 *
 * The payload is the serialized `.gnaural` deflated and base64url'd into the **fragment** — a
 * fragment is never sent to the server, so a shared link stays as local-first as everything else
 * here (§2, no backend).
 *
 * A sibling of `openFile.ts`/`saveFile.ts` rather than document-layer code: same job of getting a
 * schedule in and out of the app, and `CompressionStream` is a web API the document layer is
 * required to stay free of (§4).
 *
 * `.gnaural` XML is repetitive enough that deflate is dramatic — every one of the 19 bundled
 * programs lands between 716 and 1300 characters, the longest of them a 73-minute, 45-entry
 * schedule. `MAX_SHARE_PAYLOAD` is a guard against a pathological file, not a limit anything
 * realistic approaches.
 */

/** §5.1's "fall back to file export past ~8 KB", measured in fragment characters. */
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

/**
 * base64url — `+/` become `-_` and the padding goes, which is what makes the payload safe to drop
 * into a fragment verbatim, with no percent-encoding to inflate it again.
 */
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
