import cloudflare from '@astrojs/cloudflare'
import partytown from '@astrojs/partytown'
import react from '@astrojs/react'
import sitemap from '@astrojs/sitemap'
import { d1, r2 } from '@emdash-cms/cloudflare'
import posthog from '@posthog/rollup-plugin'
import { getBrandDomain, getLocalDomain } from '@repo/config/brand'
import tailwindcss from '@tailwindcss/vite'
import varlockAstroIntegration from '@varlock/astro-integration'
import { defineConfig } from 'astro/config'
import emdash, { local } from 'emdash/astro'
import { sqlite } from 'emdash/db'
import { fontless } from 'fontless'

const domain = getBrandDomain()
const localDomain = getLocalDomain()
const isDevCommand =
	process.env.npm_lifecycle_event === 'dev' || process.argv.includes('dev')
const isCloudflareBuild =
	process.env.npm_lifecycle_event === 'build' ||
	process.env.CLOUDFLARE_BUILD === 'true'
const shouldUploadSourceMaps = Boolean(
	isCloudflareBuild &&
	process.env.POSTHOG_PERSONAL_API_KEY &&
	process.env.POSTHOG_PROJECT_ID,
)

export default defineConfig({
	output: 'server',
	site: `https://${domain}`,
	i18n: {
		defaultLocale: 'en',
		locales: ['en', 'es', 'ar'],
		fallback: {
			es: 'en',
			ar: 'en',
		},
		routing: {
			prefixDefaultLocale: false,
			fallbackType: 'rewrite',
		},
	},
	session: isCloudflareBuild
		? {
				driver: {
					entrypoint: 'unstorage/drivers/memory',
				},
			}
		: {
				driver: {
					entrypoint: 'unstorage/drivers/fs-lite',
					config: {
						base: '.astro/session',
					},
				},
			},
	integrations: [
		emdash({
			database: isCloudflareBuild
				? d1({ binding: 'DB' })
				: sqlite({ url: 'file:./.emdash/data.db' }),
			storage: isCloudflareBuild
				? r2({ binding: 'MEDIA_BUCKET' })
				: local({
						directory: './.emdash/uploads',
						baseUrl: '/_emdash/api/media/file',
					}),
			fonts: {
				scripts: ['arabic'],
			},
			plugins: [
				{
					id: 'marketing-blocks',
					version: '0.1.0',
					adminEntry: new URL(
						'./src/plugins/marketing-blocks/admin.tsx',
						import.meta.url,
					).href,
					entrypoint: new URL(
						'./src/plugins/marketing-blocks/index.ts',
						import.meta.url,
					).href,
				},
			],
		}),
		varlockAstroIntegration(),
		{
			name: 'fix-varlock-entry-detection',
			hooks: {
				'astro:config:done': ({ config }) => {
					const varlockPlugin = config.vite.plugins
						.flat()
						.find((p) => p && p.name === 'inject-varlock-config')
					if (varlockPlugin && varlockPlugin.transform) {
						const originalTransform = varlockPlugin.transform
						varlockPlugin.transform = function (code, id, options) {
							if (id.includes('node_modules/varlock/')) {
								const originalGetModuleIds = this.getModuleIds
								this.getModuleIds = function () {
									const ids = Array.from(originalGetModuleIds.call(this))
									if (ids[0] === id) ids.unshift('FAKE_ID')
									return ids.values()
								}
								const result = originalTransform.call(this, code, id, options)
								this.getModuleIds = originalGetModuleIds
								return result
							}
							return originalTransform.call(this, code, id, options)
						}
					}
				},
			},
		},
		react(),
		sitemap({
			filter: (page) => !page.includes('/preview/') && !page.includes('/api/'),
			changefreq: 'weekly',
			priority: 0.7,
			lastmod: new Date(),
		}),
		partytown({
			config: {
				forward: [
					'dataLayer.push',
					'gtag',
					'posthog.capture',
					'posthog.captureException',
					'posthog.identify',
					'posthog.logger.error',
					'posthog.logger.info',
					'posthog.logger.warn',
				],
			},
		}),
	],

	vite: {
		resolve: {
			dedupe: ['react', 'react-dom', '@emdash-cms/admin'],
		},
		plugins: [
			shouldUploadSourceMaps
				? posthog({
						personalApiKey: process.env.POSTHOG_PERSONAL_API_KEY,
						projectId: process.env.POSTHOG_PROJECT_ID,
						host: process.env.POSTHOG_HOST,
						sourcemaps: {
							enabled: true,
							releaseName: 'menuza-web',
							releaseVersion:
								process.env.COMMIT_SHA ?? process.env.npm_package_version,
							deleteAfterUpload: true,
						},
					})
				: null,
			{
				name: 'block-emdash-on-client',
				enforce: 'pre',
				resolveId(id) {
					if (id !== 'emdash') return
					const environmentName = this.environment?.name
					if (environmentName === 'client') {
						return '\0emdash-client-empty'
					}
				},
				load(id) {
					if (id === '\0emdash-client-empty') {
						return 'export {}'
					}
				},
			},
			{
				name: 'fix-varlock-name',
				enforce: 'pre',
				transform(code, id) {
					if (id.includes('varlock/dist/')) {
						const polyfill = `if (!globalThis.__name) { globalThis.__name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true }); }\n`
						return polyfill + code.replace(/\b__name\(/g, 'globalThis.__name(')
					}
				},
			},
			tailwindcss(),
			fontless({
				defaults: {
					preload: true,
					weights: [400, 500, 600, 700],
					styles: ['normal'],
					subsets: ['latin', 'latin-ext', 'arabic'],
				},
				families: [
					{ name: 'Geist', provider: 'google' },
					{ name: 'Geist Mono', provider: 'google' },
					{ name: 'Noto Sans Arabic', provider: 'google' },
				],
			}),
		],
		server: {
			allowedHosts: [localDomain, 'localhost'],
		},
		optimizeDeps: {
			exclude: ['emdash'],
			include: [
				'react',
				'react-dom',
				'react/jsx-runtime',
				'react/jsx-dev-runtime',
				'@emdash-cms/admin',
				'@astrojs/react/client.js',
			],
		},
		define: {
			'process.env.NODE_ENV': JSON.stringify(
				process.env.NODE_ENV ?? (isDevCommand ? 'development' : 'production'),
			),
		},
	},

	adapter:
		process.env.npm_lifecycle_event === 'build'
			? cloudflare({
					imageService: 'passthrough',
				})
			: undefined,
})
