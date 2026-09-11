import { type LinguiConfig } from '@lingui/conf'

/**
 * Lingui config for this package.
 *
 * Extraction happens from the apps (their configs include this package), but the
 * macro transform used by the component tests needs a config resolvable from
 * this directory.
 */
const config: LinguiConfig = {
	sourceLocale: 'en',
	fallbackLocales: { default: 'en' },
	locales: ['en'],
	catalogs: [
		{
			path: '<rootDir>/locales/{locale}',
			include: ['<rootDir>/src'],
		},
	],
}

export default config
