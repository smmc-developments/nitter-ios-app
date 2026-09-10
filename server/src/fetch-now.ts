import { Fetcher } from './fetcher.js';
import { Scheduler } from './scheduler.js';
import { getFeed } from './db.js';
import { ImageCache } from './image-cache.js';

// One-shot fetch: run scheduler once and exit (for manual triggers or testing).
async function main() {
  const fetcher = new Fetcher();
  await fetcher.start();
  await fetcher.ensureSession();
  const imageCache = new ImageCache(fetcher);

  const scheduler = new Scheduler(fetcher, imageCache, 9999);
  await scheduler.run(true);

  // Show sample feed.
  const feed = getFeed(5);
  console.log('\n--- latest feed ---');
  for (const t of feed) {
    console.log(`@${t.author_handle}: ${(t.text_content ?? '').slice(0, 80)}`);
  }

  await fetcher.stop();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
