import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';
import { decodeWav, readBlob } from './test-wav';
import { WAV_CHUNK_FRAMES, encodeWav, wavByteLength } from './wav';

const SAMPLE_RATE = 44100;

function bufferOf(channels: number[][], sampleRate = SAMPLE_RATE): AudioBuffer {
  const context = new OfflineAudioContext(2, 128, sampleRate) as unknown as BaseAudioContext;
  const buffer = context.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((samples, channel) => buffer.getChannelData(channel).set(samples));
  return buffer;
}

function ascii(view: DataView, offset: number, length: number): string {
  return Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('');
}

describe('encodeWav', () => {
  it('writes a canonical 16-bit PCM header', async () => {
    const view = await readBlob(encodeWav(bufferOf([[0, 0, 0], [0, 0, 0]], 22050)));

    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // uncompressed PCM
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getUint32(28, true)).toBe(22050 * 2 * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(4); // block align
    expect(view.getUint16(34, true)).toBe(16); // bit depth
    expect(ascii(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(3 * 2 * 2);
    expect(view.getUint32(4, true)).toBe(view.byteLength - 8);
  });

  it('matches the size wavByteLength promises the UI', async () => {
    const blob = encodeWav(bufferOf([[0, 0, 0, 0], [0, 0, 0, 0]]));

    expect(blob.size).toBe(wavByteLength(4, 2));
    expect(blob.type).toBe('audio/wav');
  });

  it('round-trips samples within the quantisation step, interleaved per frame', async () => {
    const left = [0, 0.5, -0.5, 0.25];
    const right = [1, -1, 0.125, -0.75];

    const { channels, sampleRate } = decodeWav(await readBlob(encodeWav(bufferOf([left, right]))));

    expect(sampleRate).toBe(SAMPLE_RATE);
    left.forEach((sample, i) => expect(channels[0][i]).toBeCloseTo(sample, 4));
    right.forEach((sample, i) => expect(channels[1][i]).toBeCloseTo(sample, 4));
  });

  it('clamps samples past full scale instead of wrapping', async () => {
    const { channels } = decodeWav(await readBlob(encodeWav(bufferOf([[1.9, -1.9], [0, 0]]))));

    expect(channels[0][0]).toBeCloseTo(1, 3);
    expect(channels[0][1]).toBeCloseTo(-1, 3);
  });

  it('encodes a buffer spanning several chunks without dropping or reordering frames', async () => {
    const frames = WAV_CHUNK_FRAMES * 2 + 7;
    const left = Array.from({ length: frames }, (_, i) => Math.sin(i / 50));
    const right = left.map((sample) => -sample);

    const blob = encodeWav(bufferOf([left, right]));
    const { channels } = decodeWav(await readBlob(blob));

    expect(blob.size).toBe(wavByteLength(frames, 2));
    for (const i of [0, WAV_CHUNK_FRAMES - 1, WAV_CHUNK_FRAMES, frames - 1]) {
      expect(channels[0][i]).toBeCloseTo(left[i], 3);
      expect(channels[1][i]).toBeCloseTo(right[i], 3);
    }
  });
});
