// Token bucket: cheap per-socket flood protection for lobby actions and inputs.

export function createTokenBucket(perSecond, burst = perSecond) {
  let tokens = burst;
  let last = performance.now();

  return {
    take(count = 1) {
      const now = performance.now();
      const elapsed = (now - last) / 1000;
      last = now;
      tokens = Math.min(burst, tokens + elapsed * perSecond);
      if (tokens < count) return false;
      tokens -= count;
      return true;
    },
  };
}
