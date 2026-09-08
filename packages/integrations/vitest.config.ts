import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		setupFiles: ['./tests/setup.ts'],
		bail: 0, // Don't stop on first failure
		env: {
			VITEST: 'true',
			DATABASE_URL: 'file:./data.db',
			NODE_ENV: 'test',
			HONEYPOT_SECRET: 'super-duper-s3cret',
			INTEGRATION_ENCRYPTION_KEY:
				'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
			INTEGRATIONS_OAUTH_STATE_SECRET: 'test-oauth-state-secret-32-chars',
		},
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
				'**/fixtures/**',
			],
			include: ['src/**/*.ts', 'src/**/*.tsx'],
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
			watermarks: {
				statements: [50, 80],
				functions: [50, 80],
				branches: [50, 80],
				lines: [50, 80],
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
