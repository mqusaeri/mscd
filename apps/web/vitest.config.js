// Unit tests of the web workspace (BUILD-PLAN H.1, J.1): Vitest in the Node environment, the files
// test/**/*.test.{js,ts,tsx} (MILESTONE-2 C.7: a .tsx test file would otherwise never run, and --passWithNoTests
// would hide it). The Playwright suite in e2e/ is not part of it. Vitest matches `include` relative to `dir`, and the
// workspace script runs `vitest run --dir test`, so the pattern below is relative to test/.
// `@mscd/shared` resolves to the TypeScript sources of the contract package, as in vite.config.js, so the tests need no
// build of it (CI runs them right after `npm ci`).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [{ find: /^@mscd\/shared$/, replacement: fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) }],
  },
  test: {
    dir: 'test',
    include: ['**/*.test.{js,ts,tsx}'],
    environment: 'node',
  },
});
