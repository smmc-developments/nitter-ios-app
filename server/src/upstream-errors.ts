export class InstanceUnavailableError extends Error {}

// Recognize saved errors from older releases as well as typed current errors.
// This lets existing accounts recover without a destructive database reset.
export function isInstanceFailure(error: unknown): boolean {
  if (error instanceof InstanceUnavailableError) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /^(?:Nitter request failed\b|Request failed for https?:\/\/|Session bootstrap failed for https?:\/\/|Browser session expired for https?:\/\/|Nitter returned incomplete HTML\b|Nitter returned an error page\b|No healthy Nitter instance is currently available\b|Fetcher not started\b|429 rate limited for\b)/.test(message)
    || /^Nitter returned HTTP (?:403|418|429|5\d{2})\b/.test(message);
}
