import { default as defaultConfig } from '@repo/config/eslint-preset'

/** @type {import("eslint").Linter.Config[]} */
export default [
	...defaultConfig,
	{
		files: ['**/*.test.{ts,tsx}', '**/*.spec.ts'],
		rules: { 'epic-web/prefer-dispose-in-tests': 'off' },
	},
	{
		// Playwright fixtures are plain functions named `use`, not React hooks.
		files: ['e2e/**/*.ts'],
		rules: { 'react-hooks/rules-of-hooks': 'off' },
	},
	{
		// Loaded by Vite directly; two copies of Vite's types make it unfit for the
		// type-aware project (see tsconfig.json).
		ignores: [
			'dist/',
			'dev-dist/',
			'test-results/',
			'playwright-report/',
			'node_modules/',
			'env.d.ts',
			'vite.config.ts',
		],
	},
]
