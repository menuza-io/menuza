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
				'../../packages/marketing',
				// Only the UI holds messages; the package's ambient .d.ts files are not
				// source Lingui can parse.
				'../../packages/reports/src/ui',
				'../../packages/marketing-workflow',
			],
		},
	],
}

export default config
