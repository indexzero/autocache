// The report is the only merge operation. Comparison lives in the library.
export function mergeHandler() {
  return async ({ args, out = console.log }) => {
    const { compareRoots } = await import('@autocache/waybackify/compare.js');
    const { counts, conflicts } = await compareRoots(args.baseRoot, args.fetchRoot);
    // Serialize everything before emitting anything: invalid input cannot
    // leave a partial report on stdout.
    const rows = [
      { type: 'summary', counts },
      ...conflicts.map(conflict => ({ type: 'conflict', ...conflict }))
    ];
    out(rows.map(row => JSON.stringify(row)).join('\n'));
  };
}
