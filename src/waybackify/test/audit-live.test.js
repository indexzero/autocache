// LIVE verdict-engine tests — real CDX lookups + real replay fetches against
// archive.org. Skipped by default (the PR gate stays offline, #246/#251); run
// with WAYBACK_LIVE=1 pnpm test (or pnpm run test:live). Best-effort by
// design: archive.org throttles, so assertions prefer shape over availability
// where the archive itself is the flaky part.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { WaybackMachine } from '../index.js';
import { auditCapture } from '../audit.js';

const skip = !process.env.WAYBACK_LIVE && 'live network — set WAYBACK_LIVE=1 to run';
const VERDICTS = ['good', 'wayback404', 'suspect'];

describe('getCapture (live CDX)', { skip }, () => {
  const wayback = new WaybackMachine({ timeout: 60000 });

  it('returns the exact capture with its archived statuscode', async () => {
    // A real archived capture with a recorded manifest entry upstream.
    const cap = await wayback.getCapture(
      'http://blogs.msdn.com:80/mharsh/archive/2008/03/05/slides-and-demos-from-my-mix-08-talk.aspx',
      '20081221144742'
    );
    if (cap) {
      assert.equal(cap.timestamp, '20081221144742');
      assert.match(cap.statuscode, /^\d{3}$|^-$/);
      assert.ok(cap.original.includes('blogs.msdn.com'));
    }
    // null would mean CDX dropped the row — tolerated, the audit marks it.
  });

  it('returns null for a capture that does not exist', async () => {
    const cap = await wayback.getCapture('http://example.com/', '19910101000000');
    assert.equal(cap, null);
  });
});

describe('auditCapture (live)', { skip }, () => {
  const wayback = new WaybackMachine({ timeout: 60000 });

  it('verdicts a known-good corpus capture', async () => {
    const v = await auditCapture(
      'https://web.archive.org/web/20081221144742/http://blogs.msdn.com:80/mharsh/archive/2008/03/05/slides-and-demos-from-my-mix-08-talk.aspx',
      { wayback }
    );
    assert.ok(VERDICTS.includes(v.verdict));
    assert.equal(v.timestamp, '20081221144742');
    assert.ok(v.checkedAt);
    assert.ok(v.reason.length > 0);
    console.log(`live verdict: ${v.verdict} (${v.statuscode}) — ${v.reason}`);
  });

  it('audits a timestamp nothing was archived at without claiming a statuscode', async () => {
    // No CDX row exists for this exact capture: the replay may redirect to the
    // nearest real capture (fine, contents judged) — but the verdict must not
    // carry a fabricated statuscode for a capture that does not exist.
    const v = await auditCapture('https://web.archive.org/web/19910101000000/http://example.com/', {
      wayback
    });
    assert.ok(VERDICTS.includes(v.verdict));
    assert.equal(v.statuscode, null, 'no CDX row exists for this capture');
    console.log(`live verdict: ${v.verdict} — ${v.reason}`);
  });
});
