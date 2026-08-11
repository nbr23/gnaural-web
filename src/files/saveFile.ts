/**
 * Getting a file back out of the app, by whichever route the browser supports — the counterpart
 * to `openFile.ts`.
 *
 * Everything here takes a finished `Blob` and never builds one: the caller owns encoding, so an
 * export can be cancelled or fail with a message before any file dialog appears.
 */

interface FileSystemSaveWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable(): Promise<FileSystemWritableStream> }>;
}

interface FileSystemWritableStream {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

/** A filename from a program's title: `Power Nap` → `power-nap.wav`. */
export function fileNameFor(title: string, extension: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'program'}${extension}`;
}

/**
 * Write a blob to disk. Resolves false when the user dismisses the save dialog — a cancel is not
 * an error.
 *
 * The File System Access API where available (Chrome/Edge, including Android — the same route
 * `pickFile` prefers) writes to the chosen file directly, which for a several-hundred-megabyte
 * WAV means the browser streams it rather than holding a download in memory. Everywhere else
 * falls back to an object-URL anchor click.
 */
export async function saveBlob(suggestedName: string, blob: Blob): Promise<boolean> {
  const picker = (window as FileSystemSaveWindow).showSaveFilePicker;

  if (picker) {
    try {
      const handle = await picker.call(window, {
        suggestedName,
        types: [{ description: 'Exported file', accept: { [blob.type]: [extensionOf(suggestedName)] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return false;
      throw error;
    }
  }

  downloadBlob(suggestedName, blob);
  return true;
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // Revoked on the next turn of the event loop: the download has been handed off by then, and
  // holding the URL would pin a very large blob in memory.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}
