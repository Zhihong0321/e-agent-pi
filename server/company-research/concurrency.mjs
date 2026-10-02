// Share a small concurrency cap across every lane in a dossier.
export function createLimiter(max) {
  if (!Number.isInteger(max) || max < 1) throw new Error('Positive concurrency limit required');
  let active = 0;
  const waiting = [];
  return async work => {
    if (active >= max) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await work(); }
    finally {
      if (waiting.length) waiting.shift()();
      else active--;
    }
  };
}

export async function settleBatch(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find(r => r.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(r => r.value);
}
