import {
	type HttpRequest,
	type HttpResponse,
	type HttpTransport,
} from '@/lib/api/http'

export type Recorded = {
	request: HttpRequest
	url: URL
	body: Record<string, unknown>
}

export type StubReply = {
	status?: number
	json?: unknown
	raw?: string
	delayMs?: number
	headers?: Record<string, string>
}

type Handler = (request: HttpRequest) => StubReply

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseBody(body: string | undefined): Record<string, unknown> {
	if (!body) return {}
	try {
		const value: unknown = JSON.parse(body)
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

/** Records outgoing requests and replays canned or computed replies. */
export class StubTransport {
	readonly recorded: Recorded[] = []
	readonly #queue: StubReply[]
	readonly #handler: Handler | null

	constructor(source: StubReply[] | Handler = []) {
		this.#queue = Array.isArray(source) ? [...source] : []
		this.#handler = Array.isArray(source) ? null : source
	}

	readonly send: HttpTransport = async (request) => {
		const reply = this.#handler
			? this.#handler(request)
			: (this.#queue.shift() ?? { raw: '{}' })
		this.recorded.push({
			request,
			url: new URL(request.url),
			body: parseBody(request.body),
		})
		if (reply.delayMs) await sleep(reply.delayMs)
		const response: HttpResponse = {
			status: reply.status ?? 200,
			url: request.url,
			body: reply.raw ?? JSON.stringify(reply.json ?? {}),
			headers: { 'content-type': 'application/json', ...reply.headers },
		}
		return response
	}

	get lastRequest(): Recorded | undefined {
		return this.recorded[this.recorded.length - 1]
	}

	get paths(): string[] {
		return this.recorded.map((entry) => entry.url.pathname)
	}
}

export function header(recorded: Recorded | undefined, name: string) {
	if (!recorded) return undefined
	const match = Object.entries(recorded.request.headers).find(
		([key]) => key.toLowerCase() === name.toLowerCase(),
	)
	return match?.[1]
}

/** Always fails, like an offline device. */
export const failingTransport: HttpTransport = async () => {
	throw new TypeError('Network request failed')
}
