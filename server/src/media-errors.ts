// A missing media resource does not mean its Nitter instance is unhealthy.
export class MediaNotFoundError extends Error {
  constructor(readonly status: 404 | 410, readonly url: string) {
    super(`Upstream media request returned HTTP ${status} for ${url}`);
    this.name = 'MediaNotFoundError';
  }
}
