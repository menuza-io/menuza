import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		setupFiles: ['./tests/setup-env.ts'],
		bail: 0,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html', 'lcov', 'text-summary'],
			reportsDirectory: './coverage',
			exclude: [
				'node_modules/',
				'dist/',
				'**/*.d.ts',
				'**/*.config.*',
				'**/index.ts',
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
		},
	},
})
