/** Test-only WAV reader — the inverse of `encodeWav`, so exports can be checked by decoding
 *  them rather than by trusting the encoder. */
export function decodeWav(view: DataView): { channels: Float32Array[]; sampleRate: number } {
  const channelCount = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const frames = view.getUint32(40, true) / (channelCount * 2);

  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const sample = view.getInt16(44 + (frame * channelCount + channel) * 2, true);
      channels[channel][frame] = sample / (sample < 0 ? 0x8000 : 0x7fff);
    }
  }

  return { channels, sampleRate };
}

export async function readBlob(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}
