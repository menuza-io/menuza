import { fileURLToPath } from 'node:url'
import { lingui } from '@lingui/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import macrosPlugin from 'vite-plugin-babel-macros'
import { VitePWA } from 'vite-plugin-pwa'

// Vite 6 defaults to Safari 14, whose destructuring quirks esbuild 0.28 cannot
// lower. Use Safari 15+ consistently for dependency bundling and shipped code.
const browserTargets = ['es2020', 'chrome87', 'edge88', 'firefox78', 'safari15']

/** Blocks injected script in the shipped app (the device secret lives in this origin). */
const csp = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'", // the restaurant's theme CSS is injected as a <style>
	'img-src * data: blob:',
	'font-src * data:',
	"connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
	"worker-src 'self'",
	"manifest-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
].join('; ')

export default defineConfig({
	build: { target: browserTargets },
	optimizeDeps: { esbuildOptions: { target: browserTargets } },
	resolve: {
		alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
	},
	plugins: [
		{
			name: 'station-csp',
			apply: 'build',
			transformIndexHtml: () => [
				{
					tag: 'meta',
					attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
					injectTo: 'head-prepend',
				},
			],
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
							request.destination === 'image' || request.destination === 'font',
						handler: 'CacheFirst',
						options: {
							cacheName: 'pos-media',
							// Cross-origin images are opaque responses that browsers count as
							// several MB each against storage quota, which could stop orders being
							// saved. Keep few, and let the cache give way before the order queue.
							expiration: {
								maxEntries: 60,
								maxAgeSeconds: 60 * 60 * 24 * 30,
								purgeOnQuotaError: true,
							},
							cacheableResponse: { statuses: [0, 200] },
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
		hmr: process.env.VITE_DIRECT_DEV === '1' ? undefined : { clientPort: 2999 },
	},
})
