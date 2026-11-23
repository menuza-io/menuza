// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
	TRACE_ID_GLOBAL,
	TRACE_ID_HEADER,
	generateTraceId,
	installTraceIdFetch,
	parseTraceId,
	traceIdBootstrapScript,
	traceIdForRequest,
	withTraceId,
} from './trace-id.ts'

describe('trace id', () => {
	it('is 16 random hex characters with nothing personal in it', () => {
		const first = generateTraceId()
		expect(first).toMatch(/^[a-f0-9]{16}$/)
		expect(generateTraceId()).not.toBe(first)
	})

	it('accepts only an exact id from a client', () => {
		expect(parseTraceId('A1B2C3D4E5F6A7B8')).toBe('a1b2c3d4e5f6a7b8')
		expect(parseTraceId('a1b2c3d4e5f6a7b8\nSet-Cookie: x')).toBeNull()
		expect(parseTraceId('short')).toBeNull()
		expect(parseTraceId(undefined)).toBeNull()
	})

	it('puts one id on the request that every later reader sees', () => {
		const sent = new Request('https://app.test/x.data', {
			headers: { [TRACE_ID_HEADER]: 'a1b2c3d4e5f6a7b8' },
		})
		expect(traceIdForRequest(sent)).toBe('a1b2c3d4e5f6a7b8')
		expect(withTraceId(sent).request).toBe(sent)

		const bare = new Request('https://app.test/page')
		const { request, traceId } = withTraceId(bare)
		expect(request.headers.get(TRACE_ID_HEADER)).toBe(traceId)
		expect(traceId).toMatch(/^[a-f0-9]{16}$/)

		// A forged value is replaced, not echoed.
		const forged = new Request('https://app.test/page', {
			headers: { [TRACE_ID_HEADER]: '<script>' },
		})
		expect(withTraceId(forged).request.headers.get(TRACE_ID_HEADER)).toMatch(
			/^[a-f0-9]{16}$/,
		)
	})

	it('hands the id to the client entry through a safe script', () => {
		expect(traceIdBootstrapScript('a1b2c3d4e5f6a7b8')).toBe(
			`window.${TRACE_ID_GLOBAL}="a1b2c3d4e5f6a7b8";`,
		)
		expect(traceIdBootstrapScript('"; alert(1); "')).toBe('')
	})

	it('sends the id on every same-origin request and on no other origin', async () => {
		const seen: Array<{ url: string; header: string | null }> = []
		const target = {
			location: { origin: 'https://app.test' },
			fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url =
					typeof input === 'string'
						? input
						: String((input as URL).href ?? (input as Request).url)
				seen.push({
					url,
					header: new Headers(init?.headers).get(TRACE_ID_HEADER),
				})
				return new Response('ok')
			}) as unknown as typeof fetch,
		}
		const restore = installTraceIdFetch('a1b2c3d4e5f6a7b8', target)
		await target.fetch('/acme/orders.data')
		await target.fetch('https://app.test/resources/support', {
			method: 'POST',
			headers: { 'x-other': '1' },
		})
		await target.fetch('https://tenant-api.example/orders')
		expect(seen.map((entry) => entry.header)).toEqual([
			'a1b2c3d4e5f6a7b8',
			'a1b2c3d4e5f6a7b8',
			null,
		])
		restore()
	})
})
