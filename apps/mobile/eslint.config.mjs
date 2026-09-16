import { default as defaultConfig } from '@repo/config/eslint-preset'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

/** @type {import("eslint").Linter.Config[]} */
export default [
	...defaultConfig,
	{
		// Design-system components own their internals; they may use arbitrary
		// structural values and build class names dynamically.
		files: ['components/ui/**'],
		rules: {
			'shadcn/no-restyle': 'off',
			'shadcn/no-arbitrary-values': 'off',
			'shadcn/require-static-classes': 'off',
		},
	},
	{
		files: ['**/*.test.{ts,tsx,js,jsx}', '**/*.spec.{ts,tsx,js,jsx}'],
		rules: {
			'epic-web/prefer-dispose-in-tests': 'off',
		},
	},
	{
		ignores: ['uniwind.d.ts', 'locales/*.js'],
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
			// Add custom rules here
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_' },
			],
			'@typescript-eslint/no-explicit-any': 'warn',
		},
	},
	{
		files: ['**/*.{js,jsx}'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			parserOptions: {
				ecmaFeatures: {
					jsx: true,
				},
			},
		},
	},
	{
		files: [
			'**/*.test.{ts,tsx,js,jsx}',
			'**/jest.setup.js',
			'**/jest.setup.*.js',
		],
		languageOptions: {
			globals: {
				jest: 'readonly',
				describe: 'readonly',
				it: 'readonly',
				expect: 'readonly',
				beforeEach: 'readonly',
				afterEach: 'readonly',
				beforeAll: 'readonly',
				afterAll: 'readonly',
			},
		},
	},
]
