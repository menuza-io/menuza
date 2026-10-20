import { type LinguiConfig } from '@lingui/conf'

const config: LinguiConfig = {
	sourceLocale: 'en',
	fallbackLocales: {
		default: 'en',
	},
	locales: ['en', 'ar'],
	catalogs: [
		{
			path: '<rootDir>/app/locales/{locale}',
			include: [
				'app',
				'../../packages/ai',
				'../../packages/marketing',
				// Only the UI holds messages; the package's ambient .d.ts files are not
				// source Lingui can parse.
				'../../packages/reports/src/ui',
				'../../packages/marketing-workflow',
			],
			exclude: [
				'**/node_modules/**',
				'../../packages/**/node_modules/**',
				'../../node_modules/**',
			],
		},
	],
}

export default config
