import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.test.ts'],
		// Property tests run hundreds of carts; shared CI runners need headroom.
		testTimeout: 120_000,
	},
})
