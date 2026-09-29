import { afterEach, expect, test, vi } from 'vitest';
import { copyText } from './clipboard';

const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
const link = 'https://nitter.example/nasa/status/123';

afterEach(() => {
  vi.unstubAllGlobals();
  if (execCommandDescriptor) Object.defineProperty(document, 'execCommand', execCommandDescriptor);
  else delete (document as Partial<Document>).execCommand;
  document.body.replaceChildren();
});

test('copies with the Clipboard API', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await copyText(link);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(link);
  expect(document.querySelector('textarea')).toBeNull();
});

test.each([undefined, { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) }])('falls back when the Clipboard API is unavailable or denied (%s)', async clipboard => {
  vi.stubGlobal('navigator', { clipboard });
  const button = document.createElement('button');
  document.body.appendChild(button);
  button.focus();
  const execCommand = vi.fn().mockImplementation(() => {
    expect(document.querySelector('textarea')).toHaveValue(link);
    return true;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

  await copyText(link);

  expect(execCommand).toHaveBeenCalledExactlyOnceWith('copy');
  expect(document.querySelector('textarea')).toBeNull();
  expect(document.activeElement).toBe(button);
});

test('reports failure and cleans up when the fallback fails', async () => {
  vi.stubGlobal('navigator', { clipboard: undefined });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn().mockReturnValue(false) });
  await expect(copyText(link)).rejects.toThrow('Unable to copy to clipboard');
  expect(document.querySelector('textarea')).toBeNull();
});

test('reports failure when neither clipboard method is supported', async () => {
  vi.stubGlobal('navigator', { clipboard: undefined });
  await expect(copyText(link)).rejects.toThrow('Unable to copy to clipboard');
  expect(document.querySelector('textarea')).toBeNull();
});
