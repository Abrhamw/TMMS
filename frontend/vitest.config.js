import { defineConfig } from 'vitest/config';

// The frontend is plain JS/JSX; unit tests cover pure helpers only, so a node
// environment is enough (no DOM/React testing stack required).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
});
