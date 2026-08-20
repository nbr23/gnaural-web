import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { Window } from 'happy-dom';
import { OfflineAudioContext } from 'node-web-audio-api';
import type { ParseResult } from '../document/parser';
import { parseScheduleWithWarnings } from '../document/parser';
import { renderSchedule } from '../engine/render';
import { encodeWav } from '../engine/wav';
import type { RenderCommand } from './args';
import { USAGE, UsageError, parseCommand } from './args';

globalThis.OfflineAudioContext =
  OfflineAudioContext as unknown as typeof globalThis.OfflineAudioContext;

async function loadSchedule(path: string): Promise<ParseResult> {
  const window = new Window();
  globalThis.DOMParser = window.DOMParser as unknown as typeof globalThis.DOMParser;
  try {
    return parseScheduleWithWarnings(await readFile(path, 'utf8'));
  } finally {
    await window.happyDOM.close();
  }
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  if (!command) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const { schedule, warnings } = await loadSchedule(command.input);
  if (!command.quiet) {
    for (const warning of warnings) {
      process.stderr.write(`${warning.severity}: [${warning.kind}] ${warning.message}\n`);
    }
  }

  const buffer = await renderSchedule(schedule, {
    sampleRate: command.sampleRate,
    noise: command.noise,
    onProgress: progressReporter(command),
  });

  await write(encodeWav(buffer), command);
  if (!command.quiet) {
    process.stderr.write(
      `${command.output}: ${buffer.duration.toFixed(1)}s at ${command.sampleRate} Hz\n`,
    );
  }
}

function progressReporter(command: RenderCommand): ((fraction: number) => void) | undefined {
  if (command.quiet || !process.stderr.isTTY) return undefined;
  return (fraction) => {
    process.stderr.write(`\rrendering ${Math.round(fraction * 100)}%${fraction < 1 ? '' : '\n'}`);
  };
}

function write(wav: Blob, command: RenderCommand): Promise<void> {
  const bytes = Readable.fromWeb(wav.stream() as ReadableStream<Uint8Array>);
  return command.format === 'mp3'
    ? encodeMp3(bytes, command)
    : pipeline(bytes, createWriteStream(command.output));
}

function encodeMp3(wav: Readable, { output, quality }: RenderCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      ...['-hide_banner', '-v', 'error', '-y'],
      ...['-i', 'pipe:0'],
      ...['-codec:a', 'libmp3lame', '-q:a', String(quality)],
      output,
    ]);

    ffmpeg.stderr.pipe(process.stderr);
    ffmpeg.on('error', (error) =>
      reject(
        new Error(
          `Could not run ffmpeg (${error.message}). Install it, or write a WAV with --format wav.`,
        ),
      ),
    );
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}.`));
    });

    pipeline(wav, ffmpeg.stdin).catch(reject);
  });
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof UsageError) process.stderr.write(`\n${USAGE}\n`);
  process.exitCode = 1;
}
