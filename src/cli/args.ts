import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { NoiseLayerSettings } from '../engine/engine';
import type { NoiseColour } from '../engine/noise';
import { NOISE_COLOURS } from '../engine/noise';
import { DEFAULT_EXPORT_SAMPLE_RATE } from '../engine/render';

export type OutputFormat = 'wav' | 'mp3';

const FORMATS: OutputFormat[] = ['wav', 'mp3'];
const DEFAULT_MP3_QUALITY = 2;
const DEFAULT_NOISE_GAIN = 0.3;

export const USAGE = `gnaural-render <program.gnaural> [options]

  -o, --output <path>       output file (default: beside the input)
  -f, --format <wav|mp3>    output format (default: from --output, else wav)
  -r, --rate <hz>           sample rate (default: ${DEFAULT_EXPORT_SAMPLE_RATE})
  -q, --quality <n>         MP3 quality, 0 best to 9 worst (default: ${DEFAULT_MP3_QUALITY})
      --noise <colour[:gain]>  mix in a noise bed: ${NOISE_COLOURS.join(', ')} (gain 0-1, default ${DEFAULT_NOISE_GAIN})
      --quiet               no progress and no warnings
  -h, --help                this message`;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface RenderCommand {
  input: string;
  output: string;
  format: OutputFormat;
  sampleRate: number;
  quality: number;
  noise?: NoiseLayerSettings;
  quiet: boolean;
}

export function parseCommand(argv: readonly string[]): RenderCommand | null {
  const { values, positionals } = parseOptions(argv);
  if (values.help || positionals.length === 0) return null;
  if (positionals.length > 1) {
    throw new UsageError(`Expected one input file, got ${positionals.length}.`);
  }

  const input = positionals[0];
  const format = chooseFormat(values.format, values.output);

  return {
    input,
    output: values.output ?? defaultOutput(input, format),
    format,
    sampleRate: positiveInteger(values.rate, DEFAULT_EXPORT_SAMPLE_RATE, '--rate'),
    quality: quality(values.quality),
    noise: values.noise === undefined ? undefined : parseNoise(values.noise),
    quiet: values.quiet ?? false,
  };
}

function parseOptions(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        output: { type: 'string', short: 'o' },
        format: { type: 'string', short: 'f' },
        rate: { type: 'string', short: 'r' },
        quality: { type: 'string', short: 'q' },
        noise: { type: 'string' },
        quiet: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function chooseFormat(format: string | undefined, output: string | undefined): OutputFormat {
  if (format !== undefined) {
    if (!isFormat(format)) {
      throw new UsageError(`Unknown format "${format}". Choose ${FORMATS.join(' or ')}.`);
    }
    return format;
  }

  const extension = output === undefined ? '' : extname(output).slice(1).toLowerCase();
  if (extension === '') return 'wav';
  if (!isFormat(extension)) {
    throw new UsageError(`Cannot render a "${extension}" file. Choose ${FORMATS.join(' or ')}.`);
  }
  return extension;
}

function isFormat(value: string): value is OutputFormat {
  return (FORMATS as string[]).includes(value);
}

function defaultOutput(input: string, format: OutputFormat): string {
  const name = basename(input, extname(input));
  return join(dirname(input), `${name}.${format}`);
}

function positiveInteger(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be a positive whole number, got "${value}".`);
  }
  return parsed;
}

function quality(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MP3_QUALITY;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 9) {
    throw new UsageError(`--quality must be between 0 and 9, got "${value}".`);
  }
  return parsed;
}

function parseNoise(value: string): NoiseLayerSettings {
  const [colour, gain, ...rest] = value.split(':');
  if (!isColour(colour) || rest.length > 0) {
    throw new UsageError(
      `--noise takes <colour>[:<gain>], one of ${NOISE_COLOURS.join(', ')}, got "${value}".`,
    );
  }

  if (gain === undefined) return { colour, gain: DEFAULT_NOISE_GAIN };

  const level = Number(gain);
  if (!Number.isFinite(level) || level < 0 || level > 1) {
    throw new UsageError(`--noise gain must be between 0 and 1, got "${gain}".`);
  }
  return { colour, gain: level };
}

function isColour(value: string): value is NoiseColour {
  return (NOISE_COLOURS as string[]).includes(value);
}
