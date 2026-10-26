import { fileURLToPath } from 'node:url'
import macrosPlugin from 'vite-plugin-babel-macros'
import { defineConfig } from 'vitest/config'

// Unit tests live beside the code; `e2e/` belongs to Playwright. Lingui macros
// are compiled as in the app, and English is active (the source language).
export default defineConfig({
	plugins: [macrosPlugin()],
	resolve: {
		alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
	},
	test: { include: ['src/**/*.test.ts'], setupFiles: ['src/test-setup.ts'] },
})
