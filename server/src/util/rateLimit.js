export function createTokenBucket(perSecond, burst = perSecond) {
  let tokens = burst;
  let last = performance.now();

  return {
    take(count = 1) {
      const now = performance.now();
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSecond);
      last = now;
      if (tokens < count) return false;
      tokens -= count;
      return true;
    },
  };
}
