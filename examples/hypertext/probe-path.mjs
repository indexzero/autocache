// Read `waybackify ledger <dir> --root <root>` JSONL on stdin and print the
// serve path (/web/<timestamp>/<originalUrl>) of the first cached capture.
// The pipeline curls this path against waybackify-serve as its liveness probe.
let data = '';
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', () => {
  const rows = data
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const cached = rows.find((row) => row.state === 'cached');
  if (!cached) {
    console.error('probe-path: no cached capture in the ledger join');
    process.exit(1);
  }
  console.log(`/web/${cached.timestamp}/${cached.originalUrl}`);
});
