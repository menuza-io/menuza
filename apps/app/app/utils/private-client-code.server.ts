import {
	isPrivateManifestRoute,
	PRIVATE_ASSETS_URL_PREFIX,
	ROUTE_MANIFEST_FILE,
} from './route-visibility.ts'

/** React Router's lazy route discovery endpoint (`routeDiscovery.manifestPath`). */
export const ROUTE_DISCOVERY_PATH = '/__manifest'

type AssetFetcher = { fetch(request: Request): Promise<Response> }
type SessionCheck = (request: Request) => Promise<boolean>

function notFound() {
	return new Response('Not Found', {
		status: 404,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	})
}

/**
 * Serves `/assets/app/*` (logged-in UI code) only with a valid session and
 * hides React Router's full route manifest file. Returns null for any other
 * path, so the caller continues with the React Router handler.
 *
 * `wrangler.jsonc` routes these paths to the Worker first
 * (`assets.run_worker_first`); everything else in `/assets/` is served by
 * Cloudflare before the Worker runs.
 */
/**
 * The path a static file server would look up: percent-decoded, with `\` as
 * `/`, repeated slashes collapsed and dot segments resolved, lowercased so a
 * case-insensitive file system cannot be used either. Null when it cannot be
 * decoded. `/assets/%61pp/x.js` must count as `/assets/app/x.js`.
 */
export function assetLookupPath(rawPathname: string): string | null {
	let decoded: string
	try {
		decoded = decodeURIComponent(rawPathname)
	} catch {
		return null
	}
	// Resolve segments like a file system does, not like a URL: after decoding,
	// `#` and `?` are ordinary file name characters (`x%23%2f..%2fapp` is
	// `x#/../app`, which a static file server resolves to `app`).
	const segments: string[] = []
	for (const segment of decoded.replace(/\\/g, '/').split('/')) {
		if (segment === '' || segment === '.') continue
		if (segment === '..') segments.pop()
		else segments.push(segment)
	}
	return `/${segments.join('/')}`.toLowerCase()
}

export async function serveGatedAsset(
	request: Request,
	{ assets, hasSession }: { assets?: AssetFetcher; hasSession: SessionCheck },
): Promise<Response | null> {
	const rawPathname = new URL(request.url).pathname
	const pathname = assetLookupPath(rawPathname)
	// An undecodable path under /assets is never a file worth serving.
	if (pathname === null) {
		return rawPathname.toLowerCase().startsWith('/assets') ? notFound() : null
	}

	if (ROUTE_MANIFEST_FILE.test(pathname)) return notFound()
	if (!pathname.startsWith(PRIVATE_ASSETS_URL_PREFIX)) return null
	// Same answer for a missing file and a missing session, so the 404 does not
	// confirm that a guessed file name exists.
	if (!assets || !(await hasSession(request))) return notFound()

	const response = await assets.fetch(request)
	// 304: the signed-in browser revalidated its cached copy; keep it.
	if (!response.ok && response.status !== 304) return notFound()
	const headers = new Headers(response.headers)
	// Hashed file names never change, but no shared cache may keep a copy and
	// hand it to someone without a session.
	headers.set('Cache-Control', 'private, max-age=31536000, immutable')
	return new Response(response.status === 304 ? null : response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

/**
 * Filters React Router's `/__manifest` answer by session.
 *
 * With a session, the answer is passed through, marked private (React Router
 * marks it public and immutable). Without one, any answer that would name a
 * private route becomes `204` + `X-Remix-Reload-Document`, which tells the
 * client to load the URL as a document instead: the server then redirects to
 * the login page as usual. Answers that name only public routes pass through.
 */
export async function filterRouteDiscovery(
	request: Request,
	response: Response,
	{ hasSession }: { hasSession: SessionCheck },
): Promise<Response> {
	const { pathname } = new URL(request.url)
	if (pathname !== ROUTE_DISCOVERY_PATH || response.status !== 200) {
		return response
	}

	const headers = new Headers(response.headers)
	if (await hasSession(request)) {
		headers.set('Cache-Control', 'private, max-age=3600')
		return new Response(response.body, { status: 200, headers })
	}

	let patches: Record<string, unknown>
	try {
		patches = (await response.json()) as Record<string, unknown>
	} catch {
		return notFound()
	}
	const namesPrivateRoute = Object.values(patches).some((route) =>
		isPrivateManifestRoute(
			route as Parameters<typeof isPrivateManifestRoute>[0],
		),
	)
	if (namesPrivateRoute) {
		return new Response(null, {
			status: 204,
			headers: {
				'X-Remix-Reload-Document': 'true',
				'Cache-Control': 'no-store',
			},
		})
	}
	headers.set('Cache-Control', 'private, no-store')
	headers.delete('Content-Length')
	return Response.json(patches, { status: 200, headers })
}

type DocumentContext = {
	manifest: { routes: Record<string, unknown> }
	staticHandlerContext: { matches: ReadonlyArray<{ route: { id: string } }> }
}

/**
 * The route manifest a document may carry. React Router serializes the
 * routes matched for the URL and for its ancestor paths into the page; for
 * `/signup` that includes `/`, the logged-in dashboard. Without a session,
 * every private route that is not matched for this request is left out, so a
 * public page names no private module. The client discovers the rest through
 * `/__manifest` ({@link filterRouteDiscovery}).
 */
export function documentContextFor<Context extends DocumentContext>(
	context: Context,
	{ authenticated }: { authenticated: boolean },
): Context {
	if (authenticated) return context
	const matched = new Set(
		context.staticHandlerContext.matches.map((match) => match.route.id),
	)
	const routes = Object.fromEntries(
		Object.entries(context.manifest.routes).filter(
			([id, route]) =>
				matched.has(id) ||
				!isPrivateManifestRoute(
					route as Parameters<typeof isPrivateManifestRoute>[0],
				),
		),
	)
	return { ...context, manifest: { ...context.manifest, routes } }
}

/**
 * True when a logged-out request rendered a private route: normally its loader
 * redirects to the login page first, but an error (a POST to a page with no
 * action, a 404 thrown before the session check) can render it. Such a page
 * would name private modules that the asset gate refuses, so the caller
 * redirects to the login page instead.
 */
export function rendersPrivateRoute(context: DocumentContext) {
	return context.staticHandlerContext.matches.some(({ route }) =>
		isPrivateManifestRoute(
			context.manifest.routes[route.id] as Parameters<
				typeof isPrivateManifestRoute
			>[0],
		),
	)
}
