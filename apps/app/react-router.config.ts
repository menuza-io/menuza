import { type Config } from '@react-router/dev/config'
import { getLocalDomain } from '@repo/config/brand'

const domain = getLocalDomain()

export default {
	// Defaults to true. Set to false to enable SPA for all routes.
	ssr: true,

	routeDiscovery: { mode: 'initial' },

	future: {
		unstable_optimizeDeps: true,
	},

	// TLS dev proxy (:2999) → Vite/Workers (:3001) sends a different `Host` than
	// the browser `Origin`. Allow the public app origin for action CSRF checks.
	allowedActionOrigins: [
		`app.${domain}:2999`,
		// Direct Vite/Workers dev (Playwright, curl) without the TLS proxy.
		'localhost:3001',
	],
} satisfies Config
