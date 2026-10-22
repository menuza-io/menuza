import { type LoaderFunctionArgs } from 'react-router'

/**
 * CORS for the read-only published-site endpoints a browser app on another
 * origin needs (the walk-in POS reads the menu and branding this way).
 *
 * Everything these routes return is already public: the same payload any
 * visitor of the restaurant's website receives, with no cookies or credentials
 * involved. `*` is therefore correct, and credentials are never allowed. Only
 * simple GETs are expected, so no preflight handling is added.
 */
const PUBLIC_CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Expose-Headers': 'Cache-Control',
}

function withCors(response: Response): Response {
	const headers = new Headers(response.headers)
	for (const [name, value] of Object.entries(PUBLIC_CORS))
		headers.set(name, value)
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

/** Wraps a loader so its responses, including thrown ones (404, 429), carry CORS headers. */
export function withPublicCors<T extends LoaderFunctionArgs>(
	loader: (args: T) => Promise<Response> | Response,
) {
	return async (args: T): Promise<Response> => {
		try {
			return withCors(await loader(args))
		} catch (error) {
			if (error instanceof Response) throw withCors(error)
			throw error
		}
	}
}
