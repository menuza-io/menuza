import { crx, type ManifestV3Export } from '@crxjs/vite-plugin'
import { brand, getBrandDomain } from '@repo/config/brand'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const BROWSER = process.env.BROWSER || 'chrome'
const domain = getBrandDomain()

const baseManifest: ManifestV3Export = {
	manifest_version: 3,
	name: brand.products.extension.name,
	version: '1.0',
	description: brand.products.extension.description,
	permissions: ['storage', 'activeTab', 'scripting', 'tabs', 'cookies'],
	host_permissions: ['<all_urls>'],
	action: {
		default_popup: 'index.html',
	},
	web_accessible_resources: [
		{
			resources: ['assets/*.js'],
			matches: ['<all_urls>'],
		},
	],
	externally_connectable: {
		matches: [`*://*.${domain}/*`],
	},
}

const chromeManifest: Partial<ManifestV3Export> = {
	...baseManifest,
	name: brand.products.extension.chrome,
	background: {
		service_worker: 'src/background/index.ts',
		type: 'module',
	},
}

const firefoxManifest: Partial<ManifestV3Export> = {
	...baseManifest,
	name: brand.products.extension.firefox,
	background: {
		scripts: ['src/background/index.ts'],
		type: 'module',
	},
	applications: {
		gecko: {
			id: `${brand.slug}-extension@example.com`,
		},
	},
}

const manifest = BROWSER === 'firefox' ? firefoxManifest : chromeManifest

// https://vitejs.dev/config/
export default defineConfig(() => {
	return {
		base: './',
		build: {
			emptyOutDir: true,
			outDir: `build/${BROWSER}`,
			// MV3 only runs in modern browsers. Vite 6's default (es2020,
			// safari14) asks esbuild 0.28 to lower destructuring it cannot.
			target: 'es2022',
			rollupOptions: {
				output: {
					chunkFileNames: 'assets/chunk-[hash].js',
				},
			},
		},
		// Dev prebundling uses the same default targets, so raise them too.
		optimizeDeps: {
			esbuildOptions: { target: 'es2022' },
		},
		server: {
			port: 5173,
			strictPort: true,
			hmr: {
				port: 5173,
			},
		},
		plugins: [
			react(),
			tailwindcss(),
			crx({
				manifest: manifest as ManifestV3Export,
				contentScripts: {
					injectCss: true,
				},
			}),
		],
	}
})
