import { default as defaultConfig } from '@repo/config/eslint-preset'

/** @type {import("eslint").Linter.Config} */
export default [
	...defaultConfig,
	{
		// Design-system components own their internals; they may use arbitrary
		// structural values and build class names dynamically.
		files: ['components/**'],
		rules: {
			'shadcn/no-restyle': 'off',
			'shadcn/no-arbitrary-values': 'off',
			'shadcn/require-static-classes': 'off',
		},
	},
	{
		// Staff positions need a fixed categorical palette wider than the
		// status colors; callers pick a key, never a color class.
		files: ['components/position-color.tsx'],
		rules: { 'shadcn/no-raw-colors': 'off' },
	},
	{
		// The chart component injects chart color CSS variables through a <style> element.
		files: ['components/ui/chart.tsx'],
		rules: { 'shadcn/no-inline-styles': 'off' },
	},
	{
		files: ['**/*.ts', '**/*.tsx'],
		ignores: ['.storybook/**', '**/*.stories.tsx', '**/*.stories.ts'],
		rules: {
			'react-hooks/rules-of-hooks': 'error',
			'react-hooks/exhaustive-deps': 'warn',
		},
	},
	{
		// Storybook files use hooks in render functions, which is a valid pattern
		files: ['**/*.stories.tsx'],
		rules: {
			'react-hooks/rules-of-hooks': 'off',
		},
	},
]
