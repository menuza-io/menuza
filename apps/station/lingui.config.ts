import { type LinguiConfig } from '@lingui/conf'

const config: LinguiConfig = {
	sourceLocale: 'en',
	fallbackLocales: {
		default: 'en',
	},
	locales: ['en', 'ar'],
	catalogs: [
		{
			path: '<rootDir>/src/locales/{locale}',
			include: ['src'],
			exclude: ['**/node_modules/**', '**/*.test.ts'],
		},
	],
}

export default config
