import { defineConfig } from 'vitest/config';

// Only project tests; lib/ submodules ship their own JS tests.
export default defineConfig({ test: { include: ['shared/**/*.test.ts', 'keeper/**/*.test.ts'] } });
