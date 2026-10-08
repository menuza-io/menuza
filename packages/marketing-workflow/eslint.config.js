import { default as defaultConfig } from '@repo/config/eslint-preset'

/** @type {import("eslint").Linter.Config} */
export default [
	...defaultConfig,
	{
		files: ['**/*.ts', '**/*.tsx'],
		languageOptions: {
			parserOptions: {
				// tsconfig.json leaves tests and the Vitest config out of the build.
				projectService: {
					allowDefaultProject: ['src/*.test.ts', 'vitest.config.ts'],
				},
			},
		},
		rules: {
			'react-hooks/rules-of-hooks': 'error',
			'react-hooks/exhaustive-deps': 'warn',
		},
	},
]
