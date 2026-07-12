// EC-1 crash-atomicity child: cache one document and SIGKILL the
// process in the exact window between the body rename (protocol step 3) and
// the sidecar rename (step 5). The parent test then asserts the orphan cap/
// file is treated as ingest garbage. SIGKILL — not exit() — so nothing gets
// a chance to clean up, exactly like ^C-then-some.
//
// usage: node crash-after-body-commit.mjs <root>
import { cacheCapture } from '../../cache.js';

const root = process.argv[2];
if (!root) throw new Error('usage: crash-after-body-commit.mjs <root>');

await cacheCapture('https://web.archive.org/web/20140403040000/http://crash.example/post', {
  root,
  requisites: false,
  fetch: async () => ({
    status: 200,
    headers: { get: h => (h === 'content-type' ? 'text/html' : null) },
    text: async () => '<html><body>about to crash between renames</body></html>'
  }),
  hooks: {
    afterBodyCommit() {
      process.kill(process.pid, 'SIGKILL');
    }
  }
});

// Unreachable — reaching it means the hook did not fire.
console.error('crash child survived past afterBodyCommit');
process.exit(1);
