import { default as defaultConfig } from '@repo/config/eslint-preset'

// The preset's allow list is reused so this package only adds React Flow's
// interaction hooks (`nodrag`, `nopan`, `nowheel`), which are plain marker
// classes read by React Flow rather than Tailwind utilities.
const presetUnknownClasses = defaultConfig.find(
	(config) => config.rules?.['shadcn/no-unknown-classes'],
)?.rules['shadcn/no-unknown-classes']
const presetAllowedClasses = presetUnknownClasses?.[1]?.allow ?? []

/** @type {import("eslint").Linter.Config} */
export default [
	...defaultConfig,
	{
		files: ['**/*.ts', '**/*.tsx'],
		rules: {
			'react-hooks/rules-of-hooks': 'error',
			'react-hooks/exhaustive-deps': 'warn',
			'shadcn/no-unknown-classes': [
				'error',
				{ allow: [...presetAllowedClasses, 'nodrag', 'nopan', 'nowheel'] },
			],
		},
	},
]
