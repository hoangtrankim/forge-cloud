import { defineConfig } from 'vitest/config';

// plugins/ holds the Claude Code mod; its tests run under `claude plugin test`.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
