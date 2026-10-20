import { defineConfig } from 'vitest/config'

export default defineConfig({
	define: { __PAYMENTS_MOCK_BUNDLED__: 'true' },
	test: {
		globals: true,
		environment: 'node',
		setupFiles: ['./tests/setup.ts'],
		bail: 0,
		exclude: ['node_modules', 'dist'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html', 'lcov', 'text-summary'],
			reportsDirectory: './coverage',
			exclude: [
				'node_modules/',
				'dist/',
				'tests/',
				'**/*.d.ts',
				'**/*.config.*',
				'**/index.ts',
				'**/__mocks__/**',
			],
			include: ['src/**/*.ts'],
			skipFull: false,
			thresholds: {
				global: {
					branches: 80,
					functions: 80,
					lines: 80,
					statements: 80,
				},
				perFile: true,
			},
		},
		testTimeout: 10000,
		hookTimeout: 10000,
	},
	resolve: {
		alias: {
			'@': './src',
			'@tests': './tests',
		},
	},
})
