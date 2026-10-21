import macrosPlugin from 'vite-plugin-babel-macros'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	// Lingui's `msg`/`Trans` macros are compiled by the app's Vite pipeline; the
	// component tests here need the same transform.
	plugins: [macrosPlugin()],
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.test.{ts,tsx}'],
		setupFiles: ['./vitest.setup.ts'],
		passWithNoTests: true,
		// The editor component tests drive userEvent through a rich-text field and
		// take 2 to 6 s each on a shared CI runner; the 5 s default leaves no headroom.
		testTimeout: 30_000,
	},
})
