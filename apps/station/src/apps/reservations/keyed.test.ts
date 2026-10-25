import { describe, expect, it } from 'vitest'
import { HostApiError } from './api.ts'
import { keyed } from './keyed.ts'

/** A key factory that counts: "k1", "k2", ... so a rotation is visible. */
function keys() {
	let n = 0
	return () => `k${++n}`
}

describe('the key a booking form sends under', () => {
	it('is spent by a success: the next form gets a new one', async () => {
		const ref = { current: 'k0' }
		const seen: string[] = []
		const result = await keyed(
			ref,
			async (key) => {
				seen.push(key)
				return { ok: true }
			},
			keys(),
		)
		expect(result).toEqual({ ok: true })
		expect(seen).toEqual(['k0'])
		expect(ref.current).toBe('k1')
	})

	for (const status of [500, 502, 503, 504]) {
		it(`stays after a ${status}: the retry is the same request`, async () => {
			const ref = { current: 'k0' }
			await expect(
				keyed(
					ref,
					async () => {
						throw new HostApiError(status, `http_${status}`)
					},
					keys(),
				),
			).rejects.toBeInstanceOf(HostApiError)
			expect(ref.current).toBe('k0')
		})
	}

	it('stays when there was no answer, or too many requests, or a sign-in that ended', async () => {
		for (const failure of [
			new HostApiError(0, 'network_unavailable'),
			new HostApiError(0, 'timeout'),
			new HostApiError(408, 'http_408'),
			new HostApiError(429, 'http_429'),
			new HostApiError(401, 'staff_session_required'),
		]) {
			const ref = { current: 'k0' }
			await expect(
				keyed(
					ref,
					async () => {
						throw failure
					},
					keys(),
				),
			).rejects.toBe(failure)
			expect(ref.current).toBe('k0')
		}
	})

	for (const [status, code] of [
		[400, 'invalid_body'],
		[404, 'not_found'],
		[409, 'slot_unavailable'],
		[409, 'stale_version'],
		[422, 'invalid'],
		[403, 'not_for_station'],
	] as const) {
		it(`rotates after a ${status} "${code}": the request is dead`, async () => {
			const ref = { current: 'k0' }
			await expect(
				keyed(
					ref,
					async () => {
						throw new HostApiError(status, code)
					},
					keys(),
				),
			).rejects.toBeInstanceOf(HostApiError)
			expect(ref.current).toBe('k1')
		})
	}

	it('stays when the server already has this key: the first one went through', async () => {
		const ref = { current: 'k0' }
		await expect(
			keyed(
				ref,
				async () => {
					throw new HostApiError(409, 'idempotency_conflict')
				},
				keys(),
			),
		).rejects.toMatchObject({ code: 'idempotency_conflict' })
		expect(ref.current).toBe('k0')
	})

	it('rotates after an error that is not the server’s at all', async () => {
		const ref = { current: 'k0' }
		await expect(
			keyed(
				ref,
				async () => {
					throw new TypeError('boom')
				},
				keys(),
			),
		).rejects.toBeInstanceOf(TypeError)
		expect(ref.current).toBe('k1')
	})

	it('sends the very same key on a retry after no answer, then a new one after it lands', async () => {
		const ref = { current: 'k0' }
		const make = keys()
		const seen: string[] = []
		await keyed(
			ref,
			async (key) => {
				seen.push(key)
				throw new HostApiError(503, 'http_503')
			},
			make,
		).catch(() => undefined)
		await keyed(
			ref,
			async (key) => {
				seen.push(key)
				return 'done'
			},
			make,
		)
		expect(seen).toEqual(['k0', 'k0'])
		expect(ref.current).toBe('k1')
	})
})
