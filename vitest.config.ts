// Author, creator and maintainer: Dhruba Poudel.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/client/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    clearMocks: true,
  },
});
