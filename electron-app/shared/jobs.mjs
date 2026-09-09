export async function mapWithConcurrency(items, limit, worker) {
  const values = Array.from(items || []);
  const results = new Array(values.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await worker(values[index], index);
    }
  };
  const concurrency = Math.max(1, Math.min(Math.floor(limit) || 1, values.length || 1));
  await Promise.all(Array.from({ length: concurrency }, () => run()));
  return results;
}

/**
 * Decide which units of an interrupted chapter still need making.
 *
 * A finished unit is a whole validated video, so skipping it on resume is not
 * reuse of a cached fragment — it is not redoing work that is already done and
 * checked. That distinction is why resume stops at unit boundaries: inside a
 * unit there is no such checkpoint, and this production deliberately runs with
 * caching off.
 */
export function pendingUnits(units = [], finishedNames = []) {
  const finished = new Set(finishedNames.map(String));
  return units.filter((unit) => !finished.has(String(unit?.name)));
}
