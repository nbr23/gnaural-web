/**
 * 16-bit PCM WAV encoding of a rendered `AudioBuffer` (PLAN.md §5.1, Export & share).
 *
 * Takes the audio domain's own buffer type and hands back bytes; `src/files/` stays free of
 * audio types and only moves the resulting blob to disk.
 */

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

/**
 * How many frames are converted per `Uint8Array` handed to the `Blob`.
 *
 * Encoding in slices keeps peak JS heap at one chunk instead of a second full-size buffer beside
 * the `AudioBuffer` — which matters, since an hour-long program is already several hundred MB of
 * float samples before encoding starts.
 */
export const WAV_CHUNK_FRAMES = 65536;

/** Exact size of the file `encodeWav` would produce — the UI's estimate calls this, so what is
 *  shown and what is written cannot drift apart. */
export function wavByteLength(frames: number, channels: number): number {
  return HEADER_BYTES + frames * channels * BYTES_PER_SAMPLE;
}

function writeHeader(frames: number, channels: number, sampleRate: number): ArrayBuffer {
  const header = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(header);
  const dataBytes = frames * channels * BYTES_PER_SAMPLE;
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // format 1 = uncompressed PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, channels * BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  return header;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Interleave and quantise to signed 16-bit.
 *
 * Samples are clamped rather than normalised: summed voices legitimately exceed 1.0 (Gnaural's
 * own mix does, and a two-voice render peaks near 2), and clamping is exactly what the hardware
 * does on playback — rescaling would make the exported file quieter than what was heard, which
 * is the kind of well-meant volume fudge §3.8 lists as a shipped bug.
 */
function encodeChunk(channelData: Float32Array[], from: number, to: number): Uint8Array<ArrayBuffer> {
  const channels = channelData.length;
  const bytes = new Uint8Array((to - from) * channels * BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer);

  let offset = 0;
  for (let frame = from; frame < to; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame]));
      view.setInt16(offset, Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff)), true);
      offset += BYTES_PER_SAMPLE;
    }
  }

  return bytes;
}

/** Encode a rendered buffer as a 16-bit PCM WAV file. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channelData = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
    buffer.getChannelData(channel),
  );

  const parts: BlobPart[] = [writeHeader(buffer.length, buffer.numberOfChannels, buffer.sampleRate)];
  for (let frame = 0; frame < buffer.length; frame += WAV_CHUNK_FRAMES) {
    parts.push(encodeChunk(channelData, frame, Math.min(frame + WAV_CHUNK_FRAMES, buffer.length)));
  }

  // The browser owns blob storage from here and can spill it to disk, so the encoded file never
  // has to exist as one contiguous JS allocation.
  return new Blob(parts, { type: 'audio/wav' });
}
