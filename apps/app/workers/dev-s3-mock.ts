/**
 * Node dev intercepts S3 uploads with MSW (`@repo/test-utils/mocks/tigris`).
 * Workers dev has no MSW, so signed PUTs to `AWS_ENDPOINT_URL_S3` would hit the
 * public internet and fail. Mirror the mock bucket in the CACHE KV binding.
 */
const MOCK_S3_PREFIX = 'MOCK_S3:'

let installed = false

function storageBaseUrl(): string | null {
	const endpoint = process.env.AWS_ENDPOINT_URL_S3?.replace(/\/$/, '')
	const bucket = process.env.BUCKET_NAME
	if (!endpoint || !bucket) return null
	return `${endpoint}/${bucket}/`
}

function objectKeyFromUrl(url: string, base: string): string | null {
	if (!url.startsWith(base)) return null
	const withoutQuery = url.slice(
		0,
		url.indexOf('?') === -1 ? undefined : url.indexOf('?'),
	)
	return decodeURIComponent(withoutQuery.slice(base.length))
}

export function installDevS3Mock(env: Env) {
	if (installed) return
	if (process.env.MOCKS !== 'true' || import.meta.env.PROD) return

	const base = storageBaseUrl()
	if (!base) return

	const kv = env.CACHE
	const originalFetch = globalThis.fetch.bind(globalThis)

	globalThis.fetch = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const request = input instanceof Request ? input : new Request(input, init)
		const key = objectKeyFromUrl(request.url, base)
		if (!key) {
			return originalFetch(input, init)
		}

		if (request.method === 'PUT') {
			const body = await request.arrayBuffer()
			const contentType =
				request.headers.get('content-type') ?? 'application/octet-stream'
			await kv.put(`${MOCK_S3_PREFIX}${key}`, body, {
				metadata: { contentType },
			})
			return new Response(null, { status: 201 })
		}

		if (request.method === 'GET' || request.method === 'HEAD') {
			const stored = await kv.getWithMetadata<{ contentType?: string }>(
				`${MOCK_S3_PREFIX}${key}`,
				'arrayBuffer',
			)
			if (!stored.value) {
				return new Response('Not Found', { status: 404 })
			}
			const headers = new Headers({
				'Content-Type':
					stored.metadata?.contentType ?? 'application/octet-stream',
			})
			if (request.method === 'HEAD') {
				return new Response(null, { status: 200, headers })
			}
			return new Response(stored.value, { status: 200, headers })
		}

		if (request.method === 'DELETE') {
			await kv.delete(`${MOCK_S3_PREFIX}${key}`)
			return new Response(null, { status: 204 })
		}

		return originalFetch(input, init)
	}

	installed = true
}
