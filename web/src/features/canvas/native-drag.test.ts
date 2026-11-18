import { afterEach, expect, test, vi } from 'vitest';
import { nativeDragReady, stageOriginal, startNativeDrag } from './native-drag';

const tauri = globalThis as { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  delete tauri.__TAURI_INTERNALS__;
});

test('in a browser nothing is staged, so the ordinary drag stays', () => {
  expect(stageOriginal('browser', new File(['x'], 'a.png'))).toBeUndefined();
  expect(nativeDragReady(['browser'])).toBe(false);
});

test('a staged original is dragged by its path, once every one is on disk', async () => {
  const invoke = vi.fn(async (cmd: string) =>
    cmd === 'drag_stage' ? '/tmp/visarium-drag-out/a/north light?.png' : undefined,
  );
  tauri.__TAURI_INTERNALS__ = { invoke };

  await stageOriginal('a', new File(['bytes'], 'north light?.png', { type: 'image/png' }));
  // Plain JSON, base64 bytes: what survives the postMessage route an https page takes.
  expect(invoke).toHaveBeenCalledWith('drag_stage', {
    asset: 'a',
    name: 'north light?.png',
    data: btoa('bytes'),
  });
  // A second arrival of the same original stages nothing.
  expect(stageOriginal('a', new File(['bytes'], 'north light?.png'))).toBeUndefined();

  expect(nativeDragReady(['a'])).toBe(true);
  expect(nativeDragReady(['a', 'not-yet'])).toBe(false);

  startNativeDrag(['a']);
  expect(invoke).toHaveBeenLastCalledWith('drag_out', {
    paths: ['/tmp/visarium-drag-out/a/north light?.png'],
  });
});

test('a page the app has not granted falls back to the ordinary drag', async () => {
  tauri.__TAURI_INTERNALS__ = {
    invoke: vi.fn(async () => {
      throw new Error('drag_stage not allowed');
    }),
  };
  await expect(stageOriginal('refused', new File(['x'], 'b.png'))).rejects.toThrow();
  expect(nativeDragReady(['refused'])).toBe(false);
});
