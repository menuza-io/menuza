import { fetch } from 'expo/fetch'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type HttpRequest = {
	method: HttpMethod
	url: string
	headers: Record<string, string>
	body?: string
	timeoutMs: number
}

export type HttpResponse = {
	status: number
	url: string
	body: string
	/** Lowercased names. */
	headers: Record<string, string>
}

/** Network seam, so every client is testable without a network. */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>

/**
 * Redirects are not followed: following one would send the customer token and
 * the site's `Origin` on to wherever it points. A 3xx comes back as a plain
 * response, which the clients treat as an error. Expo's fetch, because React
 * Native's own ignores `redirect`.
 */
export const fetchTransport: HttpTransport = async (request) => {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), request.timeoutMs)
	try {
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
			credentials: 'omit',
			redirect: 'manual',
			signal: controller.signal,
		})
		const headers: Record<string, string> = {}
		response.headers.forEach((value, name) => {
			headers[name.toLowerCase()] = value
		})
		return {
			status: response.status,
			url: response.url || request.url,
			body: await response.text(),
			headers,
		}
	} finally {
		clearTimeout(timer)
	}
}
