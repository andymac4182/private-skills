import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/**/*.test.ts', 'workers/**/*.test.ts', 'tests/**/*.test.ts', 'apps/web/src/**/*.test.ts'], testTimeout: 15000, hookTimeout: 30000 } });
