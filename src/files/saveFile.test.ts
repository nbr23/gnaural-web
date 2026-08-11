import { describe, expect, it } from 'vitest';
import { fileNameFor } from './saveFile';

describe('fileNameFor', () => {
  it('slugs a program title', () => {
    expect(fileNameFor('Power Nap', '.wav')).toBe('power-nap.wav');
    expect(fileNameFor('OOBE — Lucid Dreams 2', '.gnaural')).toBe('oobe-lucid-dreams-2.gnaural');
  });

  it('falls back to a usable name when the title is empty or unusable', () => {
    expect(fileNameFor('', '.wav')).toBe('program.wav');
    expect(fileNameFor('   ', '.wav')).toBe('program.wav');
    expect(fileNameFor('///', '.wav')).toBe('program.wav');
  });
});
