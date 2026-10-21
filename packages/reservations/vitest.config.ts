import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.test.ts'],
		// Property and scale tests run hundreds of scenarios; shared CI runners need headroom.
		testTimeout: 120_000,
	},
})
