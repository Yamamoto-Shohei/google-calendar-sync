/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function errorMessage(err) {
  const apiMessage = err?.response?.data?.error?.message;
  return apiMessage || err?.message || String(err);
}
