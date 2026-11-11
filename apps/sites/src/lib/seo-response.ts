import { type APIContext } from 'astro'

/**
 * Shared bits of the `robots.txt`, `sitemap.xml` and `llms.txt` routes. They
 * live only at the site root: a language-prefixed copy (`/ar/sitemap.xml`,
 * which the middleware rewrites here) is a 404.
 */
export function isRootSeoRequest(context: APIContext): boolean {
	return context.locals.requestedLocale === context.locals.defaultLocale
}

export function seoOrigin(context: APIContext): string {
	return context.url.origin
}

export function textResponse(
	body: string,
	contentType: string,
	status = 200,
): Response {
	return new Response(body, {
		status,
		headers: {
			'Content-Type': contentType,
			// Short at the edge so a publish shows up within minutes.
			'Cache-Control':
				status === 200
					? 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600'
					: 'no-store',
		},
	})
}

export function notFound(): Response {
	return textResponse('Not Found', 'text/plain; charset=utf-8', 404)
}
