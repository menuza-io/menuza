import { describe, expect, it, vi } from 'vitest'
import { searchLogsByTraceId } from './log-search.js'
import { generateTraceId, parseTraceId } from './request-context.js'

const config = { apiToken: 'token-123456', sourceId: '42' }

function fakeFetch(rows: unknown[], ok = true) {
	return vi.fn(
		async () =>
			new Response(JSON.stringify({ data: rows }), { status: ok ? 200 : 500 }),
	) as unknown as typeof fetch
}

describe('trace ids', () => {
	it('are 16 hex characters with nothing personal in them', () => {
		const id = generateTraceId()
		expect(id).toMatch(/^[a-f0-9]{16}$/)
		expect(parseTraceId(id)).toBe(id)
		expect(parseTraceId(id.toUpperCase())).toBe(id)
	})

	it('refuse anything that is not exactly an id', () => {
		for (const bad of [
			'',
			'abc',
			'zzzzzzzzzzzzzzzz',
			'a1b2c3d4e5f6a7b8 or 1=1',
			null,
			42,
		]) {
			expect(parseTraceId(bad as unknown)).toBeNull()
		}
	})
})

describe('searchLogsByTraceId', () => {
	it('finds the log lines of one request by its id', async () => {
		const traceId = 'a1b2c3d4e5f6a7b8'
		const fetchImpl = fakeFetch([
			{
				dt: '2026-11-23T10:00:00Z',
				level: 'error',
				json: {
					traceId,
					message: 'Request completed with error',
					method: 'POST',
					path: '/acme/orders',
					statusCode: 500,
					durationMs: 120,
					outcome: 'error',
					errorType: 'TypeError',
					cookie: 'secret-cookie',
				},
			},
			{ dt: 'x', json: { traceId: 'ffffffffffffffff', message: 'other' } },
		])
		const result = await searchLogsByTraceId(traceId, config, { fetchImpl })
		expect(result.status).toBe('ok')
		if (result.status !== 'ok') return
		expect(result.hits).toHaveLength(1)
		expect(result.hits[0]).toMatchObject({
			level: 'error',
			path: '/acme/orders',
			statusCode: 500,
			errorType: 'TypeError',
		})
		// Only allowlisted fields come back.
		expect(JSON.stringify(result)).not.toContain('secret-cookie')
		const url = String(
			(fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0],
		)
		expect(url).toContain(`query=traceId%3A${traceId}`)
	})

	it('never sends a malformed id to the provider', async () => {
		const fetchImpl = fakeFetch([])
		const result = await searchLogsByTraceId('x" OR 1=1', config, { fetchImpl })
		expect(result.status).toBe('invalid_id')
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('says when the provider is not set up or not reachable', async () => {
		expect((await searchLogsByTraceId('a1b2c3d4e5f6a7b8', null)).status).toBe(
			'not_configured',
		)
		expect(
			(
				await searchLogsByTraceId('a1b2c3d4e5f6a7b8', config, {
					fetchImpl: fakeFetch([], false),
				})
			).status,
		).toBe('unavailable')
	})
})
