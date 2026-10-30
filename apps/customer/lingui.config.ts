import { type LinguiConfig } from '@lingui/conf'

const config: LinguiConfig = {
	sourceLocale: 'en',
	fallbackLocales: {
		default: 'en',
	},
	locales: ['en', 'ar', 'de', 'es', 'fr', 'zh'],
	catalogs: [
		{
			path: '<rootDir>/locales/{locale}',
			include: ['app', 'components', 'lib'],
			exclude: ['**/*.test.ts', '**/*.test.tsx'],
		},
	],
}

export default config
