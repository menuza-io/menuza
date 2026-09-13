import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import { lingui } from '@lingui/vite-plugin'
import { reactRouter } from '@react-router/dev/vite'
import { getLocalDomain } from '@repo/config/brand'
import tailwindcss from '@tailwindcss/vite'
import { varlockVitePlugin } from '@varlock/vite-integration'
import { defineConfig, type Plugin } from 'vite'
import { envOnlyMacros } from 'vite-env-only'
import macrosPlugin from 'vite-plugin-babel-macros'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const domain = `admin.${getLocalDomain()}`

const MODE = process.env.NODE_ENV
const isCloudflareDeploy = process.env.DEPLOY_TARGET === 'cloudflare'

function cloudflareWorkerAliasPlugin(): Plugin | null {
	if (!isCloudflareDeploy) return null
	const workerFile = (name: string) => path.resolve(__dirname, 'workers', name)
	const ssrOnly: Record<string, string> = {
		'isomorphic-dompurify': workerFile('dompurify-stub.ts'),
	}
	const always: Record<string, string> = {
		'node:sqlite': workerFile('node-sqlite-stub.ts'),
	}
	const remixCrypto = workerFile('remix-crypto-stub.ts')
	return {
		name: 'cloudflare-worker-aliases',
		enforce: 'pre',
		resolveId(id, _importer, options) {
			if (always[id]) return always[id]
			if (/remix-utils\/build\/common\/crypto/.test(id)) return remixCrypto
			if (options?.ssr && ssrOnly[id]) return ssrOnly[id]
			return null
		},
	}
}

// Plugin to stub out cache.server.ts in test mode to avoid node:sqlite in jsdom
function stubCacheServerPlugin(): Plugin {
	return {
		name: 'stub-cache-server',
		enforce: 'pre',
		resolveId(id) {
			if (MODE === 'test' && id.includes('cache.server')) {
				return '\0virtual:cache-server-stub'
			}
		},
		load(id) {
			if (id === '\0virtual:cache-server-stub') {
				return `
					export const cachified = () => Promise.resolve();
					export const cache = { 
						delete: () => {}, 
						clear: () => {},
						clearAll: () => {},
						set: () => {},
						get: () => {}
					};
					export const ssoCache = {
						delete: () => {},
						clear: () => {},
						clearAll: () => {},
						set: () => {},
						get: () => {},
						getEndpoints: () => null,
						setEndpoints: () => {}
					};
					export default {};
				`
			}
		},
	}
}

export default defineConfig((config) => ({
	base: MODE === 'test' ? 'http://localhost:3004' : undefined,
	build: {
		target: 'es2022',
		cssMinify: MODE === 'production',

		rollupOptions: isCloudflareDeploy
			? {}
			: {
					input: config.isSsrBuild ? './server/app.ts' : undefined,
					external: [/node:.*/, 'fsevents'],
				},

		assetsInlineLimit: isCloudflareDeploy
			? 4096
			: (source: string) => {
					if (typeof source === 'string' && source.includes('/app/assets')) {
						return false
					}
				},

		// The Cloudflare bundle includes the entire SSR dependency graph. Generating
		// source maps for it pushes the CI build beyond the hosted runner's heap.
		sourcemap: !isCloudflareDeploy,
	},
	optimizeDeps: {
		include: ['@repo/email', '@repo/integrations', '@repo/ai', '@repo/ui'],
		exclude: ['@repo/marketing', '@repo/marketing-workflow'],
	},
	...(MODE !== 'test' && {
		ssr: {
			noExternal: isCloudflareDeploy
				? true
				: [/^@repo\//, '@posthog/react', 'posthog-js'],
		},
	}),
	server: {
		// Amp orbs expose dev servers through generated portal hostnames.
		allowedHosts: process.env.AMP_ORB ? true : [domain, 'localhost'],
		watch: {
			ignored: ['**/playwright-report/**', '**/node_modules/.vite-temp/**'],
		},
		fs: {
			allow: ['..'],
		},
		hmr: {
			host: 'localhost',
			port: 24678,
			protocol: 'ws',
		},
	},
	plugins: [
		isCloudflareDeploy
			? cloudflare({ viteEnvironment: { name: 'ssr' } })
			: null,
		cloudflareWorkerAliasPlugin(),
		varlockVitePlugin(
			isCloudflareDeploy
				? {
						ssrEdgeRuntime: true,
						ssrEntryModuleIds: ['\0virtual:cloudflare/worker-entry'],
						ssrInjectMode: 'resolved-env',
					}
				: undefined,
		),
		MODE === 'test' ? stubCacheServerPlugin() : null,
		envOnlyMacros(),
		tailwindcss(),
		// reactRouterDevTools(),
		// it would be really nice to have this enabled in tests, but we'll have to
		// wait until https://github.com/remix-run/remix/issues/9871 is fixed
		MODE === 'test' ? null : reactRouter(),
		macrosPlugin(),
		lingui(),
	].filter(Boolean) as Plugin[],
	test: {
		include: ['./app/**/*.test.{ts,tsx}'],
		setupFiles: ['./tests/setup/setup-test-env.ts'],
		globalSetup: ['./tests/setup/global-setup.ts'],
		environment: 'node',
		env: {
			BASE_URL: 'http://localhost:3004',
		},
		envFile: '../../.env',
		restoreMocks: true,
		testTimeout: 15000,
		pool: 'threads',
		coverage: {
			include: ['app/**/*.{ts,tsx}'],
			all: true,
		},
	},
}))
