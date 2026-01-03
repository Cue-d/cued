import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/renderer/src/__tests__/setup.ts'],
    include: ['src/renderer/src/**/*.test.{ts,tsx}']
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src')
    }
  }
})
