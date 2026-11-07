import {
	type Request as ExpressRequest,
	type RequestHandler,
	type Response as ExpressResponse,
} from 'express'
import {
	filterRouteDiscovery,
	serveGatedAsset,
} from './private-client-code.server.ts'

type SessionCheck = (request: Request) => Promise<boolean>

/**
 * A Fetch API request for a GET/HEAD Express request (no body: only used for
 * static files and `/__manifest`, which are both GET).
 */
export function toFetchRequest(req: ExpressRequest) {
	const headers = new Headers()
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry)
		} else {
			headers.set(name, value)
		}
	}
	return new Request(`${req.protocol}://${req.get('host')}${req.originalUrl}`, {
		method: req.method,
		headers,
	})
}

/** Writes a Fetch API response, keeping each `Set-Cookie` header separate. */
export async function sendFetchResponse(
	res: ExpressResponse,
	response: Response,
) {
	res.status(response.status)
	response.headers.forEach((value, name) => {
		if (name.toLowerCase() !== 'set-cookie') res.setHeader(name, value)
	})
	const cookies = response.headers.getSetCookie()
	if (cookies.length > 0) res.setHeader('Set-Cookie', cookies)
	res.end(Buffer.from(await response.arrayBuffer()))
}

/**
 * Express middleware for the Node production server, mounted at the root
 * before every `express.static` (an `/assets` mount would miss
 * `/%61ssets/app/x.js`, which the root static handler decodes and serves): the
 * same rules as the Worker
 * (`serveGatedAsset`). It decides on the decoded path, so `/assets/%61pp/x.js`
 * is gated like `/assets/app/x.js`. A request it allows falls through to the
 * static handler.
 */
export function privateAssetsMiddleware(
	hasSession: SessionCheck,
): RequestHandler {
	return async (req, res, next) => {
		try {
			const gated = await serveGatedAsset(toFetchRequest(req), {
				// Only asks "may this request read the file?"; express.static serves it.
				assets: { fetch: async () => new Response(null, { status: 200 }) },
				hasSession,
			})
			if (!gated || gated.status === 200) return next()
			await sendFetchResponse(res, gated)
		} catch (error) {
			next(error)
		}
	}
}

/** Express handler for `/__manifest` that filters React Router's answer. */
export function routeDiscoveryHandler(
	handleFetch: (request: Request) => Promise<Response>,
	hasSession: SessionCheck,
): RequestHandler {
	return async (req, res, next) => {
		try {
			const request = toFetchRequest(req)
			const response = await handleFetch(request)
			await sendFetchResponse(
				res,
				await filterRouteDiscovery(request, response, { hasSession }),
			)
		} catch (error) {
			next(error)
		}
	}
}

/** `Cache-Control` for files `express.static` serves from `/assets/app/`. */
export function setPrivateAssetHeaders(res: ExpressResponse, filePath: string) {
	if (/[/\\]assets[/\\]app[/\\]/i.test(filePath)) {
		res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
	}
}
