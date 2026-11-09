import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	getInventoryFeatures,
	getInventoryFlagState,
	INVENTORY_CONTEXT_FAILURE_COOLDOWN_MS,
	INVENTORY_CONTEXT_FRESH_TTL_MS,
	INVENTORY_CONTEXT_STALE_OFF_TTL_MS,
	INVENTORY_CONTEXT_STALE_ON_TTL_MS,
	inventoryRefusal,
	invalidateInventoryContext,
	seedInventoryContextForTest,
} from './inventory-context.ts'

const ORG = 'org_inv_flags_1'
const ON = {
	enabled: true,
	purchasing: true,
	recipes: false,
	prep: false,
	transfers: false,
}
const OFF = { ...ON, enabled: false, purchasing: false }
const ALL_OFF = {
	enabled: false,
	purchasing: false,
	recipes: false,
	prep: false,
	transfers: false,
}
const T0 = Date.UTC(2026, 10, 8, 12, 0, 0)

type Answer = () => Promise<Response>

let answer: Answer
let urls: string[]
let auth: Array<string | null>

beforeEach(() => {
	vi.stubEnv('APP_URL', 'https://app.test/')
	vi.stubEnv(
		'INTERNAL_COMMAND_TOKEN',
		'test-internal-token-very-long-and-secure-12345',
	)
	vi.stubEnv('INVENTORY_ENABLED', '')
	urls = []
	auth = []
	answer = async () => Response.json({ orgId: ORG, features: ON })
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			urls.push(String(input))
			auth.push(new Headers(init?.headers).get('Authorization'))
			return answer()
		}),
	)
	invalidateInventoryContext()
})

afterEach(() => {
	invalidateInventoryContext()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe('reading the organization’s inventory flags', () => {
	it('asks App at /resources/inventory/context with the internal token and keeps the answer five minutes', async () => {
		expect(await getInventoryFlagState(ORG, { now: T0 })).toEqual({
			status: 'on',
			features: ON,
		})
		expect(urls).toEqual([
			`https://app.test/resources/inventory/context?orgId=${ORG}`,
		])
		expect(auth).toEqual([
			'Bearer test-internal-token-very-long-and-secure-12345',
		])
		await getInventoryFlagState(ORG, {
			now: T0 + INVENTORY_CONTEXT_FRESH_TTL_MS - 1,
		})
		expect(urls).toHaveLength(1)
		await getInventoryFlagState(ORG, {
			now: T0 + INVENTORY_CONTEXT_FRESH_TTL_MS,
		})
		expect(urls).toHaveLength(2)
	})

	it('folds children under the master flag: App saying off is off', async () => {
		answer = async () => Response.json({ orgId: ORG, features: OFF })
		expect(await getInventoryFlagState(ORG, { now: T0 })).toEqual({
			status: 'off',
			features: ALL_OFF,
		})
		expect(
			inventoryRefusal(await getInventoryFlagState(ORG, { now: T0 })),
		).toBe('inventory_disabled')
	})

	it('fails closed: unreachable, bad status, wrong organization and malformed answers are unknown (all off)', async () => {
		const answers: Answer[] = [
			async () => {
				throw new TypeError('fetch failed')
			},
			async () => new Response('nope', { status: 500 }),
			async () => Response.json({ orgId: 'org_other', features: ON }),
			async () => Response.json({ orgId: ORG, features: { enabled: 'yes' } }),
			async () => new Response('not json'),
		]
		for (const [index, next] of answers.entries()) {
			invalidateInventoryContext()
			answer = next
			const state = await getInventoryFlagState(ORG, { now: T0 })
			expect(state, `answer ${index}`).toEqual({
				status: 'unknown',
				features: ALL_OFF,
			})
			expect(inventoryRefusal(state)).toBe('inventory_unavailable')
		}
	})

	it('lets a cached on stand in for 15 minutes and a cached off for a day while App is down, and waits 30 seconds between failed tries', async () => {
		seedInventoryContextForTest(ORG, ON, T0)
		answer = async () => {
			throw new TypeError('fetch failed')
		}
		const staleOn = T0 + INVENTORY_CONTEXT_FRESH_TTL_MS
		expect((await getInventoryFlagState(ORG, { now: staleOn })).status).toBe(
			'on',
		)
		expect(urls).toHaveLength(1)
		// Inside the cool-down: no new request.
		await getInventoryFlagState(ORG, {
			now: staleOn + INVENTORY_CONTEXT_FAILURE_COOLDOWN_MS - 1,
		})
		expect(urls).toHaveLength(1)
		expect(
			(
				await getInventoryFlagState(ORG, {
					now: T0 + INVENTORY_CONTEXT_STALE_ON_TTL_MS,
				})
			).status,
		).toBe('unknown')

		invalidateInventoryContext()
		seedInventoryContextForTest(ORG, ALL_OFF, T0)
		expect(
			(
				await getInventoryFlagState(ORG, {
					now: T0 + INVENTORY_CONTEXT_STALE_OFF_TTL_MS - 1,
				})
			).status,
		).toBe('off')
	})

	it('the kill switch stops everything without asking App; a bad org id is off', async () => {
		vi.stubEnv('INVENTORY_ENABLED', 'false')
		expect(await getInventoryFlagState(ORG, { now: T0 })).toEqual({
			status: 'stopped',
			features: ALL_OFF,
		})
		expect(urls).toEqual([])
		vi.stubEnv('INVENTORY_ENABLED', '')
		expect(await getInventoryFeatures('../bad', { now: T0 })).toEqual(ALL_OFF)
		expect(urls).toEqual([])
	})

	it('is not configured without APP_URL or a long internal token', async () => {
		vi.stubEnv('APP_URL', '')
		expect((await getInventoryFlagState(ORG, { now: T0 })).status).toBe(
			'unknown',
		)
		expect(urls).toEqual([])
	})
})
