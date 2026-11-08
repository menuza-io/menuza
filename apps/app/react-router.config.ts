import { type Config } from '@react-router/dev/config'
import { getLocalDomain } from '@repo/config/brand'

const domain = getLocalDomain()

export default {
	// Defaults to true. Set to false to enable SPA for all routes.
	ssr: true,

	// Lazy discovery ("fog of war"): the document lists only the routes matched
	// for its URL, and the client asks `/__manifest` for the rest as links
	// appear. Logged-out visitors never get private routes from either: see
	// `app/utils/route-visibility.ts`.
	routeDiscovery: { mode: 'lazy' },

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
