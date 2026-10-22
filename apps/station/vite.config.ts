import { fileURLToPath } from 'node:url'
import { lingui } from '@lingui/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import macrosPlugin from 'vite-plugin-babel-macros'
import { VitePWA } from 'vite-plugin-pwa'

// Vite 6 defaults to Safari 14, whose destructuring quirks esbuild 0.28 cannot
// lower. Use Safari 15+ consistently for dependency bundling and shipped code.
const browserTargets = ['es2020', 'chrome87', 'edge88', 'firefox78', 'safari15']

/** An http(s) origin, or null. */
const originOf = (value: string | undefined): string | null => {
	if (!value?.trim()) return null
	try {
		const url = new URL(value.trim())
		return url.protocol === 'https:' || url.protocol === 'http:'
			? url.origin
			: null
	} catch {
		return null
	}
}

/**
 * The servers this build may talk to: the deployment's allow-list plus the
 * default App and tenant-api origins. Pairing refuses anything else (see
 * `serverOriginProblem` in src/lib/pairing.ts), and the CSP below enforces it.
 */
function trustedOrigins(env: Record<string, string>): string[] {
	const listed = (env.VITE_POS_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((o) => originOf(o))
	return [
		...new Set(
			[
				...listed,
				originOf(env.VITE_APP_URL),
				originOf(env.VITE_TENANT_API_URL),
			].filter((o): o is string => o !== null),
		),
	]
}

/**
 * Blocks injected script in the shipped app (the device secret lives in this
 * origin) and limits where it can send data. Images and fonts may come from any
 * https host (menu photos and brand fonts live on the restaurant's CDN).
 */
function contentSecurityPolicy(origins: string[], asHeader: boolean): string {
	return [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'", // the restaurant's theme CSS is injected as a <style>
		`img-src ${["'self'", 'https:', 'data:', 'blob:', ...origins].join(' ')}`,
		`font-src ${["'self'", 'https:', 'data:', ...origins].join(' ')}`,
		`connect-src ${["'self'", ...origins].join(' ')}`,
		"worker-src 'self'",
		"manifest-src 'self'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		// Only honoured as a header: the PIN and settings screens must never be framed.
		...(asHeader ? ["frame-ancestors 'none'"] : []),
	].join('; ')
}

/**
 * `_headers` for Cloudflare Pages (or any host that reads the format). A `<meta>`
 * CSP cannot set `frame-ancestors`, so the real policy is a header. The
 * service worker gets no page CSP: its own fetches (cached menu photos from the
 * restaurant's CDN) would otherwise fall under `connect-src`.
 */
function headersFile(origins: string[]): string {
	return `/*
  Content-Security-Policy: ${contentSecurityPolicy(origins, true)}
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin

/index.html
  Cache-Control: no-cache

/sw.js
  ! Content-Security-Policy
  Cache-Control: no-cache

/manifest.webmanifest
  Cache-Control: no-cache
`
}

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), 'VITE_')
	const origins = trustedOrigins(env)
	return {
		build: { target: browserTargets },
		optimizeDeps: { esbuildOptions: { target: browserTargets } },
		resolve: {
			alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
		},
		plugins: [
			{
				name: 'station-csp',
				apply: 'build',
				configResolved() {
					if (!(env.VITE_POS_ALLOWED_ORIGINS ?? '').trim())
						console.warn(
							'\n[station] VITE_POS_ALLOWED_ORIGINS is empty: this production build will refuse to pair with or connect to any server. Set it to the App and tenant-api origins this deployment serves.\n',
						)
				},
				transformIndexHtml: () => [
					{
						tag: 'meta',
						attrs: {
							'http-equiv': 'Content-Security-Policy',
							content: contentSecurityPolicy(origins, false),
						},
						injectTo: 'head-prepend',
					},
				],
				generateBundle() {
					this.emitFile({
						type: 'asset',
						fileName: '_headers',
						source: headersFile(origins),
					})
				},
			},
			react(),
			// Lingui macros (`@lingui/macro`) and `.po` catalogs, as in apps/app.
			macrosPlugin(),
			lingui(),
			tailwindcss(),
			VitePWA({
				// 'prompt': a new version waits until the till is idle (see lib/update.ts)
				// instead of reloading the page in the middle of a sale.
				registerType: 'prompt',
				injectRegister: false,
				includeAssets: ['icon.svg'],
				manifest: {
					name: 'Station',
					short_name: 'Station',
					description: 'Station tablet app for restaurant operations',
					display: 'standalone',
					orientation: 'landscape',
					start_url: '/',
					background_color: '#ffffff',
					theme_color: '#ffffff',
					icons: [
						{
							src: 'icon.svg',
							sizes: 'any',
							type: 'image/svg+xml',
							purpose: 'any maskable',
						},
					],
				},
				workbox: {
					globPatterns: ['**/*.{js,css,html,svg,woff2}'],
					navigateFallback: '/index.html',
					runtimeCaching: [
						{
							// Menu photos and uploaded brand fonts keep working offline.
							urlPattern: ({ request }) =>
								request.destination === 'image' ||
								request.destination === 'font',
							handler: 'CacheFirst',
							options: {
								cacheName: 'pos-media',
								// Keep few, and let the cache give way before the order queue.
								expiration: {
									maxEntries: 60,
									maxAgeSeconds: 60 * 60 * 24 * 30,
									purgeOnQuotaError: true,
								},
								// Only real successes. An opaque response (status 0) could be a
								// failure, kept for 30 days, and counts several MB against quota.
								// Images served with CORS headers are cached; others load online only.
								cacheableResponse: { statuses: [200] },
							},
						},
					],
				},
			}),
		],
		server: {
			port: 3010,
			strictPort: true,
			host: true,
			// Use the page's hostname and protocol for both HTTPS and HTTP proxy dev.
			// Direct localhost:3010 use can opt out of the proxy's HMR port.
			hmr:
				process.env.VITE_DIRECT_DEV === '1' ? undefined : { clientPort: 2999 },
		},
	}
})
