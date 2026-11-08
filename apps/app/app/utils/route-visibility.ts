/**
 * Which route modules a logged-out visitor may download.
 *
 * The client build puts every route module (and every chunk only those modules
 * use) under `/assets/app/`, except the routes listed here and the code they
 * import. The Worker answers 404 for `/assets/app/*` without a valid session,
 * strips private routes from `/__manifest` for logged-out visitors, and the
 * document never lists them. See `docs/security.md#private-client-code`.
 *
 * A route belongs here when a logged-out visitor can open it, or when a page
 * they can open sends a fetcher or form to it (theme switch, cookie consent,
 * passkey sign-in). Leave a route out when it needs a session: listing it only
 * makes its UI code downloadable without an account.
 *
 * Patterns are matched against the route file path relative to `app/routes/`:
 * a pattern with a `.ts` / `.tsx` extension matches that one file, anything
 * else is a prefix (`_auth+/` is the folder, `kiosk` covers `kiosk.pair.tsx`).
 */
export const PUBLIC_ROUTE_PATTERNS: readonly string[] = [
	// 404 page for unknown URLs.
	'$.tsx',
	// Sign in, sign up, 2FA and email verification, password reset, OAuth and
	// SSO callbacks, onboarding of a verified email, passkey sign-in, logout.
	'_auth+/',
	// Robots, sitemap and OAuth metadata.
	'_seo+/',
	'[.]well-known.',
	// Invitation links open before the invitee has an account.
	'join+/',
	// Short links.
	'r+/',
	// Paired shared-tablet time clock and the private-link staff schedule:
	// both work without an operator login.
	'kiosk',
	'my-schedule.tsx',
	// Payment mock pages stand in for Stripe and Checkout.com hosted pages,
	// which a buyer opens without an App session. Dev and E2E only: the
	// Cloudflare build strips the folder (`STRIP_DEV_MOCKS` in app/routes.ts).
	'mock-payments+/',
	// Mobile sign-in API and health checks.
	'api+/auth.',
	'api+/health',
	'api+/status.ts',
	// Used by public pages: theme and cookie banner fetchers, image and font
	// optimizers, the health check.
	'resources+/theme-switch.tsx',
	'resources+/cookie-consent.ts',
	'resources+/images.tsx',
	'resources+/fonts.tsx',
	'resources+/healthcheck.tsx',
]

/** Output folder (inside the client build) for code that needs a session. */
export const PRIVATE_ASSETS_DIR = 'assets/app'

/** URL prefix of {@link PRIVATE_ASSETS_DIR}. */
export const PRIVATE_ASSETS_URL_PREFIX = `/${PRIVATE_ASSETS_DIR}/`

/**
 * React Router writes the full browser manifest to `assets/manifest-<hash>.js`
 * even in lazy discovery mode, where nothing loads it. It lists every route,
 * so the build deletes it and the Worker answers 404 for the pattern.
 */
export const ROUTE_MANIFEST_FILE = /^\/?assets\/manifest-[\w-]+\.js$/

export function isPublicRouteFile(fileRelativeToRoutes: string) {
	const file = fileRelativeToRoutes.replace(/\\/g, '/').replace(/^\.\//, '')
	return PUBLIC_ROUTE_PATTERNS.some((pattern) =>
		/\.tsx?$/.test(pattern) ? file === pattern : file.startsWith(pattern),
	)
}

/** True for a built module URL that needs a session to download. */
export function isPrivateModuleUrl(url: string | undefined) {
	if (!url) return false
	let pathname = url
	try {
		pathname = new URL(url, 'http://x').pathname
	} catch {
		// Keep the raw value.
	}
	return pathname.startsWith(PRIVATE_ASSETS_URL_PREFIX)
}

type ManifestRoute = {
	module?: string
	clientActionModule?: string
	clientLoaderModule?: string
	clientMiddlewareModule?: string
	hydrateFallbackModule?: string
	imports?: string[]
}

/** True when any file a manifest route entry points at needs a session. */
export function isPrivateManifestRoute(route: ManifestRoute | undefined) {
	if (!route) return false
	return [
		route.module,
		route.clientActionModule,
		route.clientLoaderModule,
		route.clientMiddlewareModule,
		route.hydrateFallbackModule,
		...(route.imports ?? []),
	].some(isPrivateModuleUrl)
}
