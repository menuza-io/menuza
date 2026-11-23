import { z } from 'zod'
import { parseTraceId } from './request-context.js'

/**
 * Looks up the server log lines of one request by its trace id (#385), through
 * the log provider the platform already ships logs to (Better Stack, the same
 * vendor as the uptime client in `betterstack-client.ts`). Support gets the
 * reference id from an owner's error page and finds the request with this.
 *
 * The provider call sits behind a plain `fetch` so tests inject a fake: no
 * test reaches the provider. Only the fields below are returned, never a raw
 * row, so nothing the provider adds can reach the Admin page.
 */

const TELEMETRY_BASE_URL = 'https://telemetry.betterstack.com/api/v2'

export type LogSearchConfig = {
	/** A Better Stack Telemetry API token. */
	apiToken: string
	/** The id of the log source that receives the App and Admin logs. */
	sourceId: string
}

export type LogSearchHit = {
	at: string | null
	level: string | null
	message: string | null
	service: string | null
	method: string | null
	path: string | null
	statusCode: number | null
	durationMs: number | null
	outcome: string | null
	errorType: string | null
}

export type LogSearchResult =
	| { status: 'ok'; traceId: string; hits: LogSearchHit[] }
	| { status: 'invalid_id' }
	| { status: 'not_configured' }
	| { status: 'unavailable' }

const rowSchema = z.record(z.string(), z.unknown())
const responseSchema = z.object({
	data: z.array(rowSchema).default([]),
})

function text(value: unknown): string | null {
	return typeof value === 'string' && value ? value.slice(0, 500) : null
}

function number(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** One provider row, reduced to the allowlisted fields. */
export function toLogSearchHit(row: Record<string, unknown>): LogSearchHit {
	// Rows come either flat or with the fields nested under `json` / `attributes`.
	const nested = [row.json, row.attributes, row.raw].find(
		(value): value is Record<string, unknown> =>
			Boolean(value) && typeof value === 'object',
	)
	const get = (key: string) =>
		nested && key in nested ? nested[key] : row[key]
	return {
		at: text(get('dt') ?? get('timestamp')),
		level: text(get('level')),
		message: text(get('message') ?? get('msg')),
		service: text(get('service')),
		method: text(get('method')),
		path: text(get('path')),
		statusCode: number(get('statusCode')),
		durationMs: number(get('durationMs')),
		outcome: text(get('outcome')),
		errorType: text(get('errorType')),
	}
}

export async function searchLogsByTraceId(
	rawTraceId: string,
	config: Partial<LogSearchConfig> | null | undefined,
	options: { fetchImpl?: typeof fetch; limit?: number } = {},
): Promise<LogSearchResult> {
	// The id is validated before it is put into a provider query, so a pasted
	// string can never widen the search.
	const traceId = parseTraceId(rawTraceId)
	if (!traceId) return { status: 'invalid_id' }
	if (!config?.apiToken || !config.sourceId) return { status: 'not_configured' }

	const fetchImpl = options.fetchImpl ?? fetch
	const url = new URL(`${TELEMETRY_BASE_URL}/query/live-tail`)
	url.searchParams.set('source_ids', config.sourceId)
	url.searchParams.set('query', `traceId:${traceId}`)
	url.searchParams.set('batch', String(options.limit ?? 50))
	url.searchParams.set('order', 'oldest_first')
	try {
		const response = await fetchImpl(url, {
			headers: { Authorization: `Bearer ${config.apiToken}` },
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) return { status: 'unavailable' }
		const parsed = responseSchema.safeParse(await response.json())
		if (!parsed.success) return { status: 'unavailable' }
		// The provider matches text loosely: keep only the lines that carry this id.
		const hits = parsed.data.data
			.filter((row) => JSON.stringify(row).includes(traceId))
			.map(toLogSearchHit)
		return { status: 'ok', traceId, hits }
	} catch {
		return { status: 'unavailable' }
	}
}
