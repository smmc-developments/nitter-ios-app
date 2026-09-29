export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Try the legacy copy command when clipboard access is denied.
    }
  }

  // The Clipboard API is unavailable on non-HTTPS deployments.
  const previousFocus = document.activeElement;
  const input = document.createElement('textarea');
  input.value = text;
  input.readOnly = true;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  try {
    input.focus();
    input.select();
    if (!document.execCommand?.('copy')) throw new Error('Unable to copy to clipboard');
  } finally {
    input.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
}
