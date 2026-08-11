/**
 * Getting a `.gnaural` file's text into the app, by whichever route the browser supports.
 *
 * Everything here returns plain text and never parses — the caller owns parsing so it can catch
 * a malformed file and show a message instead of an exception, and so the text it stores in the
 * library is the file's own bytes.
 */

export interface OpenedFile {
  name: string;
  text: string;
}

export const GNAURAL_EXTENSION = '.gnaural';

interface FileSystemPickerWindow {
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ getFile(): Promise<File> }[]>;
}

/**
 * The File System Access API where available (Chrome/Edge, including Android), falling back to a
 * throwaway `<input type="file">` everywhere else. Returns null when the user cancels — a
 * cancelled picker is not an error.
 */
export async function pickFile(): Promise<OpenedFile | null> {
  const picker = (window as FileSystemPickerWindow).showOpenFilePicker;

  if (picker) {
    try {
      const [handle] = await picker.call(window, {
        multiple: false,
        types: [{ description: 'Gnaural schedule', accept: { 'application/xml': [GNAURAL_EXTENSION] } }],
      });
      return handle ? readFile(await handle.getFile()) : null;
    } catch (error) {
      // The spec throws AbortError when the user dismisses the picker; that is a cancel.
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    }
  }

  return pickWithInput();
}

function pickWithInput(): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${GNAURAL_EXTENSION},application/xml,text/xml`;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      resolve(file ? readFile(file) : null);
    });
    // Firefox fires no event on cancel, so the promise simply never settles — acceptable for a
    // one-shot picker, and the element is not attached to the document either way.
    input.click();
  });
}

/** The first file from a drop, or null if the drop carried none. */
export function droppedFile(transfer: DataTransfer | null): Promise<OpenedFile> | null {
  const file = transfer?.files?.[0];
  return file ? readFile(file) : null;
}

async function readFile(file: File): Promise<OpenedFile> {
  return { name: file.name, text: await file.text() };
}
