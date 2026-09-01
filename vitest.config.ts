import { defineConfig } from 'vitest/config';

// The unit suite covers pure logic (log parsing, vector math), so it runs in a
// plain Node environment — no workerd pool needed, which keeps `npm test` fast
// and runnable in CI without Cloudflare credentials.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
