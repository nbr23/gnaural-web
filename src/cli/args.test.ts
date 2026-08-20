import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_SAMPLE_RATE } from '../engine/render';
import { UsageError, parseCommand } from './args';

describe('parseCommand', () => {
  it('renders a WAV beside the input by default', () => {
    expect(parseCommand(['fixtures/powernap.gnaural'])).toEqual({
      input: 'fixtures/powernap.gnaural',
      output: 'fixtures/powernap.wav',
      format: 'wav',
      sampleRate: DEFAULT_EXPORT_SAMPLE_RATE,
      quality: 2,
      noise: undefined,
      quiet: false,
    });
  });

  it('takes the format from the output extension', () => {
    const command = parseCommand(['nap.gnaural', '-o', '/tmp/nap.MP3']);
    expect(command).toMatchObject({ output: '/tmp/nap.MP3', format: 'mp3' });
  });

  it('lets an explicit format disagree with the output extension', () => {
    const command = parseCommand(['nap.gnaural', '-o', '/tmp/nap.out', '--format', 'mp3']);
    expect(command).toMatchObject({ format: 'mp3' });
  });

  it('names the default output after the input, whatever its extension', () => {
    expect(parseCommand(['/programs/deep sleep.xml', '-f', 'mp3'])).toMatchObject({
      output: '/programs/deep sleep.mp3',
    });
  });

  it('reads a noise bed with and without a gain', () => {
    expect(parseCommand(['nap.gnaural', '--noise', 'pink:0.2'])).toMatchObject({
      noise: { colour: 'pink', gain: 0.2 },
    });
    expect(parseCommand(['nap.gnaural', '--noise', 'brown'])).toMatchObject({
      noise: { colour: 'brown', gain: 0.3 },
    });
  });

  it('reads the remaining options', () => {
    expect(parseCommand(['nap.gnaural', '-r', '22050', '-q', '5', '--quiet'])).toMatchObject({
      sampleRate: 22050,
      quality: 5,
      quiet: true,
    });
  });

  it('asks for help when given none, and when asked', () => {
    expect(parseCommand([])).toBeNull();
    expect(parseCommand(['--help'])).toBeNull();
    expect(parseCommand(['nap.gnaural', '-h'])).toBeNull();
  });

  it('rejects what it cannot render', () => {
    expect(() => parseCommand(['nap.gnaural', '-f', 'ogg'])).toThrow(UsageError);
    expect(() => parseCommand(['nap.gnaural', '-o', 'nap.flac'])).toThrow(UsageError);
    expect(() => parseCommand(['nap.gnaural', '--noise', 'purple'])).toThrow(UsageError);
    expect(() => parseCommand(['nap.gnaural', '--noise', 'pink:8'])).toThrow(UsageError);
    expect(() => parseCommand(['nap.gnaural', '-r', '0'])).toThrow(UsageError);
    expect(() => parseCommand(['nap.gnaural', '-r', '44.1'])).toThrow(UsageError);
    expect(() => parseCommand(['nap.gnaural', '-q', '11'])).toThrow(UsageError);
    expect(() => parseCommand(['one.gnaural', 'two.gnaural'])).toThrow(UsageError);
    expect(() => parseCommand(['nap.gnaural', '--louder'])).toThrow(UsageError);
  });
});
