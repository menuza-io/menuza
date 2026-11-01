import { fileURLToPath } from 'node:url'
import cloudflare from '@astrojs/cloudflare'
import partytown from '@astrojs/partytown'
import { lingui } from '@lingui/vite-plugin'
import { SITE_FONTS } from '@repo/common/site-fonts'
import { getBrandDomain, getLocalDomain } from '@repo/config/brand'
import tailwindcss from '@tailwindcss/vite'
import varlockAstroIntegration from '@varlock/astro-integration'
import { defineConfig } from 'astro/config'
import { fontless } from 'fontless'

const domain = getBrandDomain()
const localDomain = getLocalDomain()

export default defineConfig({
	output: 'server',
	site: `https://${domain}`,
	security: {
		checkOrigin: false,
	},
	integrations: [
		varlockAstroIntegration(),
		partytown({
			config: {
				forward: ['dataLayer.push', 'gtag'],
			},
		}),
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
	],

	vite: {
		plugins: [
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
			process.env.npm_lifecycle_event !== 'build' && {
				name: 'mock-cloudflare-workers',
				resolveId(id) {
					if (id === 'cloudflare:workers') {
						return '\0cloudflare:workers'
					}
				},
				load(id) {
					if (id === '\0cloudflare:workers') {
						return `export const env = {};`
					}
				},
			},
			tailwindcss(),
			lingui(),
			fontless({
				defaults: {
					preload: false,
					weights: [400, 500, 600, 700],
					styles: ['normal'],
					subsets: ['latin', 'latin-ext', 'arabic'],
				},
				families: [
					{
						name: 'GeistPixel',
						weights: ['400'],
						src: [{ url: '/fonts/GeistPixel-Square.woff2', format: 'woff2' }],
					},
					{ name: 'SiteHeading', provider: 'none' },
					{ name: 'SiteBody', provider: 'none' },
					...SITE_FONTS.map((font) => ({
						name: font.family,
						provider: 'google',
						weights: ['400', '500', '600', '700'],
					})),
				],
			}),
		],
		server: {
			// Allow org subdomains via the local proxy
			allowedHosts: [`.${localDomain}`, localDomain, 'localhost'],
		},
		optimizeDeps: {
			exclude: ['@lingui/core/macro'],
			// The cart and menu scripts reach zod through shared workspace code
			// (`@repo/common`, `@repo/discounts`). Left to be discovered while the
			// page is open, Vite re-optimizes it, the page keeps asking for the old
			// bundle and gets a 503/504, and the whole menu script dies silently:
			// nothing on the page reacts to a click. Bundle it up front.
			include: ['zod'],
		},
		resolve: {
			alias: {
				// Astro frontmatter cannot compile Babel macros; keep `msg\`...\``
				// in source for Lingui extract, resolve to a runtime descriptor.
				'@lingui/core/macro': fileURLToPath(
					new URL('./src/lib/lingui-macro-runtime.ts', import.meta.url),
				),
				zlib: 'node:zlib',
				http: 'node:http',
				https: 'node:https',
				crypto: 'node:crypto',
				util: 'node:util',
				stream: 'node:stream',
				buffer: 'node:buffer',
				events: 'node:events',
				path: 'node:path',
				url: 'node:url',
				fs: 'node:fs',
				os: 'node:os',
			},
		},
		ssr: {
			noExternal: ['@lingui/core', '@lingui/message-utils'],
			external: [
				'node:zlib',
				'node:http',
				'node:https',
				'node:path',
				'node:url',
				'node:fs',
				'node:http2',
				'node:buffer',
				'node:crypto',
				'node:os',
				'node:child_process',
				'node:tty',
				'node:worker_threads',
				'node:net',
				'node:stream',
				'node:util',
				'node:events',
				'node:querystring',
				'node:assert',
			],
		},
		define: {
			'process.env.NODE_ENV': JSON.stringify(
				process.env.NODE_ENV || 'production',
			),
		},
		build: {
			rollupOptions: {
				output: {
					assetFileNames(info) {
						const name = info.names?.[0] ?? info.name ?? ''
						if (name.includes('site-fonts')) {
							return '_astro/site-fonts.css'
						}
						return '_astro/[name].[hash][extname]'
					},
				},
			},
		},
	},

	build: {
		// Keep shared CSS as an asset when it is large enough to benefit from
		// browser caching across public tenant-site pages.
		inlineStylesheets: 'auto',
	},

	adapter:
		process.env.npm_lifecycle_event === 'build'
			? cloudflare({
					imageService: 'passthrough',
				})
			: undefined,
})
