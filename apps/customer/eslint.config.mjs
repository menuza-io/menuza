import { default as defaultConfig } from '@repo/config/eslint-preset'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

/** @type {import("eslint").Linter.Config[]} */
export default [
	...defaultConfig,
	{
		// Design-system components own their internals; they may build class
		// names from variants.
		files: ['components/ui/**'],
		rules: {
			'shadcn/no-restyle': 'off',
			'shadcn/no-arbitrary-values': 'off',
			'shadcn/require-static-classes': 'off',
			// Safe-area insets are runtime values Tailwind cannot express.
			'shadcn/no-inline-styles': 'off',
		},
	},
	{
		files: ['**/*.test.{ts,tsx,js,jsx}'],
		rules: {
			'epic-web/prefer-dispose-in-tests': 'off',
		},
	},
	{
		ignores: [
			'types/*.d.ts',
			'uniwind-env.d.ts',
			'expo-env.d.ts',
			'locales/*.js',
			'dist/**',
			'coverage/**',
		],
	},
	{
		files: ['**/*.{ts,tsx}'],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				ecmaVersion: 'latest',
				sourceType: 'module',
				ecmaFeatures: {
					jsx: true,
				},
			},
		},
		plugins: {
			'@typescript-eslint': tseslint,
		},
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^(_|ignored)', varsIgnorePattern: '^(_|ignored)' },
			],
			'@typescript-eslint/no-explicit-any': 'error',
		},
	},
	{
		files: ['**/*.{js,jsx,mjs}'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
		},
	},
	{
		files: ['**/*.test.{ts,tsx,js,jsx}', 'jest.setup.js', 'test/**'],
		languageOptions: {
			globals: {
				jest: 'readonly',
				describe: 'readonly',
				it: 'readonly',
				test: 'readonly',
				expect: 'readonly',
				beforeEach: 'readonly',
				afterEach: 'readonly',
				beforeAll: 'readonly',
				afterAll: 'readonly',
			},
		},
	},
]
