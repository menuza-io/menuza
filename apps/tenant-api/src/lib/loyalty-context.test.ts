import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	getLoyaltyFeatures,
	getLoyaltyFlagState,
	invalidateLoyaltyContext,
	LOYALTY_CONTEXT_FAILURE_COOLDOWN_MS,
	LOYALTY_CONTEXT_FRESH_TTL_MS,
	LOYALTY_CONTEXT_STALE_OFF_TTL_MS,
	LOYALTY_CONTEXT_STALE_ON_TTL_MS,
	LOYALTY_CONTEXT_TIMEOUT_MS,
	loyaltyCreditsSales,
	loyaltyRefusal,
	rewardRefusal,
	seedLoyaltyContextForTest,
} from './loyalty-context.ts'

const ORG = 'org_flags_1'
const ON = { enabled: true, redemption: true }
const OFF = { enabled: false, redemption: false }
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0)

type Answer = (init?: RequestInit) => Promise<Response>

let answer: Answer
let calls: number

const unreachable: Answer = async () => {
	throw new TypeError('fetch failed')
}

/** An App that never answers; only the caller's timeout ends the request. */
const hanging: Answer = (init) =>
	new Promise((_, reject) => {
		init?.signal?.addEventListener('abort', () =>
			reject(new DOMException('The operation was aborted.', 'AbortError')),
		)
	})

beforeEach(() => {
	vi.stubEnv('APP_URL', 'https://app.test')
	vi.stubEnv(
		'INTERNAL_COMMAND_TOKEN',
		'test-internal-token-very-long-and-secure-12345',
	)
	vi.stubEnv('LOYALTY_ENABLED', '')
	calls = 0
	answer = async () => Response.json({ orgId: ORG, features: ON })
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			calls += 1
			return answer(init)
		}),
	)
	invalidateLoyaltyContext()
})

afterEach(() => {
	invalidateLoyaltyContext()
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe('reading the organization’s loyalty flags', () => {
	it('reads them from App and keeps the answer five minutes', async () => {
		expect(await getLoyaltyFlagState(ORG, { now: T0 })).toEqual({
			status: 'on',
			features: ON,
		})
		await getLoyaltyFlagState(ORG, {
			now: T0 + LOYALTY_CONTEXT_FRESH_TTL_MS - 1,
		})
		expect(calls).toBe(1)
		await getLoyaltyFlagState(ORG, { now: T0 + LOYALTY_CONTEXT_FRESH_TTL_MS })
		expect(calls).toBe(2)
	})

	it('tells off from unknown: App saying off is off, App not answering is unknown', async () => {
		answer = async () => Response.json({ orgId: ORG, features: OFF })
		const off = await getLoyaltyFlagState(ORG, { now: T0 })
		expect(off).toEqual({ status: 'off', features: OFF })
		expect(loyaltyCreditsSales(off)).toBe(false)
		expect(loyaltyRefusal(off)).toBe('loyalty_disabled')
		expect(rewardRefusal(off)).toBe('loyalty_disabled')

		invalidateLoyaltyContext()
		answer = unreachable
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		const unknown = await getLoyaltyFlagState(ORG, { now: T0 })
		expect(unknown).toEqual({ status: 'unknown', features: OFF })
		// A member's sale is still credited; nothing new can be spent.
		expect(loyaltyCreditsSales(unknown)).toBe(true)
		expect(loyaltyRefusal(unknown)).toBe('loyalty_unavailable')
		expect(rewardRefusal(unknown)).toBe('loyalty_unavailable')
		expect(await getLoyaltyFeatures(ORG, { now: T0 })).toEqual(OFF)
		expect(errors).toHaveBeenCalledTimes(1)
		expect(errors).toHaveBeenCalledWith('Loyalty flags could not be read', {
			orgId: ORG,
			reason: 'unreachable',
			status: 'unknown',
			stale: false,
		})
	})

	it('refuses spending when only redemption is off', async () => {
		answer = async () =>
			Response.json({ orgId: ORG, features: { ...ON, redemption: false } })
		const state = await getLoyaltyFlagState(ORG, { now: T0 })
		expect(state.status).toBe('on')
		expect(loyaltyRefusal(state)).toBeNull()
		expect(rewardRefusal(state)).toBe('redemption_disabled')
		expect(loyaltyCreditsSales(state)).toBe(true)
	})

	it('treats an error, a malformed answer or another organization’s as unreadable', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const answers: Answer[] = [
			async () => new Response('down', { status: 503 }),
			async () => new Response('not json', { status: 200 }),
			async () => Response.json({ orgId: ORG, features: { enabled: 'yes' } }),
			async () => Response.json({ orgId: 'org_other', features: ON }),
		]
		for (const next of answers) {
			invalidateLoyaltyContext()
			answer = next
			expect((await getLoyaltyFlagState(ORG, { now: T0 })).status).toBe(
				'unknown',
			)
		}
		expect(console.error).toHaveBeenCalledWith(
			'Loyalty flags could not be read',
			expect.objectContaining({ orgId: ORG, reason: 'http_503' }),
		)
		expect(console.error).toHaveBeenCalledWith(
			'Loyalty flags could not be read',
			expect.objectContaining({ orgId: ORG, reason: 'invalid_response' }),
		)
	})

	it('asks App once for reads that overlap, and not again for 30 seconds after a failure', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		answer = async () => new Response('down', { status: 502 })
		const states = await Promise.all(
			Array.from({ length: 5 }, () => getLoyaltyFlagState(ORG, { now: T0 })),
		)
		expect(states.every((state) => state.status === 'unknown')).toBe(true)
		expect(calls).toBe(1)
		expect(console.error).toHaveBeenCalledTimes(1)

		const cooling = await getLoyaltyFlagState(ORG, {
			now: T0 + LOYALTY_CONTEXT_FAILURE_COOLDOWN_MS - 1,
		})
		expect(cooling.status).toBe('unknown')
		expect(calls).toBe(1)

		answer = async () => Response.json({ orgId: ORG, features: ON })
		const back = await getLoyaltyFlagState(ORG, {
			now: T0 + LOYALTY_CONTEXT_FAILURE_COOLDOWN_MS,
		})
		expect(back.status).toBe('on')
		expect(calls).toBe(2)
	})

	it('stops waiting for a slow App after the timeout', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		vi.spyOn(console, 'error').mockImplementation(() => {})
		answer = hanging
		let settled = false
		const read = getLoyaltyFlagState(ORG).then((state) => {
			settled = true
			return state
		})
		const second = getLoyaltyFlagState(ORG)
		await vi.advanceTimersByTimeAsync(LOYALTY_CONTEXT_TIMEOUT_MS - 1)
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect(await read).toEqual({ status: 'unknown', features: OFF })
		expect(await second).toEqual({ status: 'unknown', features: OFF })
		expect(calls).toBe(1)
		expect(console.error).toHaveBeenCalledWith(
			'Loyalty flags could not be read',
			expect.objectContaining({ orgId: ORG, reason: 'timeout' }),
		)
	})

	it('uses a stale on for at most 15 minutes while App is down', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		seedLoyaltyContextForTest(ORG, ON, T0)
		answer = unreachable
		const stale = await getLoyaltyFlagState(ORG, {
			now: T0 + LOYALTY_CONTEXT_FRESH_TTL_MS,
		})
		expect(stale).toEqual({ status: 'on', features: ON })
		expect(console.error).toHaveBeenCalledWith(
			'Loyalty flags could not be read',
			{ orgId: ORG, reason: 'unreachable', status: 'on', stale: true },
		)
		const lapsed = await getLoyaltyFlagState(ORG, {
			now: T0 + LOYALTY_CONTEXT_STALE_ON_TTL_MS,
		})
		expect(lapsed).toEqual({ status: 'unknown', features: OFF })
		expect(calls).toBe(2)
	})

	it('uses a stale off for up to a day while App is down', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		seedLoyaltyContextForTest(ORG, OFF, T0)
		answer = unreachable
		expect(
			await getLoyaltyFlagState(ORG, {
				now: T0 + LOYALTY_CONTEXT_STALE_OFF_TTL_MS - 60_000,
			}),
		).toEqual({ status: 'off', features: OFF })
		expect(
			(
				await getLoyaltyFlagState(ORG, {
					now: T0 + LOYALTY_CONTEXT_STALE_OFF_TTL_MS,
				})
			).status,
		).toBe('unknown')
	})

	it('the node kill switch stops loyalty without asking App', async () => {
		vi.stubEnv('LOYALTY_ENABLED', 'false')
		seedLoyaltyContextForTest(ORG, ON, T0)
		const state = await getLoyaltyFlagState(ORG, { now: T0 })
		expect(state).toEqual({ status: 'stopped', features: OFF })
		expect(calls).toBe(0)
		expect(loyaltyCreditsSales(state)).toBe(false)
		expect(loyaltyRefusal(state)).toBe('loyalty_unavailable')
		expect(rewardRefusal(state)).toBe('loyalty_unavailable')
	})

	it('a read that was running when the cache was cleared does not refill it', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		let finish: (response: Response) => void = () => {}
		answer = () =>
			new Promise((resolve) => {
				finish = resolve
			})
		const read = getLoyaltyFlagState(ORG, { now: T0 })
		await vi.advanceTimersByTimeAsync(0)
		invalidateLoyaltyContext(ORG)
		finish(Response.json({ orgId: ORG, features: ON }))
		expect((await read).status).toBe('on')
		answer = async () => Response.json({ orgId: ORG, features: OFF })
		expect((await getLoyaltyFlagState(ORG, { now: T0 })).status).toBe('off')
		expect(calls).toBe(2)
	})
})
