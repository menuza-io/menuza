import path from 'node:path'
import { lingui } from '@lingui/vite-plugin'
import { getViteConfig } from 'astro/config'

/**
 * Renders `.astro` pages with Astro's container API (no adapter, no varlock):
 * `*.astro.test.ts` files. The plain `vitest.config.ts` runs everything else.
 */
export default getViteConfig(
	{
		// The page chrome loads the `.po` catalogs.
		plugins: [lingui()],
		resolve: {
			alias: {
				'~': path.resolve(import.meta.dirname, './src'),
				'@lingui/core/macro': path.resolve(
					import.meta.dirname,
					'./src/lib/lingui-macro-runtime.ts',
				),
				// Workers-only module: the tests run in Node.
				'cloudflare:workers': path.resolve(
					import.meta.dirname,
					'./src/test/cloudflare-workers-stub.ts',
				),
			},
		},
		test: {
			globals: true,
			environment: 'node',
			include: ['src/**/*.astro.test.ts'],
		},
	},
	{ configFile: false, logLevel: 'error' },
)
