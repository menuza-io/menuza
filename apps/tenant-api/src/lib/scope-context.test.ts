import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	getScopeFacts,
	getStaffingFeatures,
	primeScopeFacts,
	resetScopeContextCache,
} from './scope-context.ts'

const ORG = 'org_abcdefghij'

function okResponse(timeZone = 'America/Chicago') {
	return Response.json({
		orgId: ORG,
		scopes: [{ id: 'loc_1', name: 'Downtown', timeZone, isActive: true }],
	})
}

describe('scope facts from the control plane', () => {
	const fetchMock = vi.fn()

	beforeEach(() => {
		resetScopeContextCache()
		fetchMock.mockReset()
		vi.stubGlobal('fetch', fetchMock)
		vi.stubEnv('APP_URL', 'https://app.example.test')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'x'.repeat(32))
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it('can be primed by a seed script, without asking the App', async () => {
		primeScopeFacts(
			ORG,
			[
				{ id: 'loc_1', name: 'Downtown', timeZone: 'America/Chicago' },
				{ id: 'loc_2', name: 'Bad zone', timeZone: 'Mars/Olympus' },
			],
			1_000,
		)
		expect(await getScopeFacts(ORG, 'loc_1', 2_000)).toEqual({
			name: 'Downtown',
			timeZone: 'America/Chicago',
		})
		// A time zone that is not real is dropped, as it is when the App sends it.
		expect(await getScopeFacts(ORG, 'loc_2', 2_000)).toBeNull()
		expect(fetchMock).not.toHaveBeenCalled()
		// Flags are never primed: they still come from the App.
		expect(await getStaffingFeatures(ORG, 2_000)).toBeNull()
	})

	it('caches a good answer for a few minutes', async () => {
		fetchMock.mockResolvedValue(okResponse())
		const first = await getScopeFacts(ORG, 'loc_1', 1_000)
		const second = await getScopeFacts(ORG, 'loc_1', 60_000)
		expect(first).toEqual({ name: 'Downtown', timeZone: 'America/Chicago' })
		expect(second).toEqual(first)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('does not ask a failing App again on every punch', async () => {
		fetchMock.mockRejectedValue(new Error('timeout'))
		for (let i = 0; i < 20; i++) {
			expect(await getScopeFacts(ORG, 'loc_1', 1_000 + i * 100)).toBeNull()
		}
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('tries again once the cooldown has passed and recovers', async () => {
		fetchMock.mockRejectedValueOnce(new Error('down'))
		expect(await getScopeFacts(ORG, 'loc_1', 1_000)).toBeNull()
		fetchMock.mockResolvedValueOnce(okResponse())
		expect(await getScopeFacts(ORG, 'loc_1', 40_000)).toEqual({
			name: 'Downtown',
			timeZone: 'America/Chicago',
		})
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('prefers a stale answer to none while the App is unreachable', async () => {
		fetchMock.mockResolvedValueOnce(okResponse())
		await getScopeFacts(ORG, 'loc_1', 1_000)
		fetchMock.mockRejectedValue(new Error('down'))
		const stale = await getScopeFacts(ORG, 'loc_1', 10 * 60_000)
		expect(stale).toEqual({ name: 'Downtown', timeZone: 'America/Chicago' })
		// Still inside the cooldown: no second attempt.
		await getScopeFacts(ORG, 'loc_1', 10 * 60_000 + 5_000)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('refuses a response for another organization', async () => {
		fetchMock.mockResolvedValue(
			Response.json({
				orgId: 'org_someoneelse1',
				scopes: [
					{ id: 'loc_1', name: 'X', timeZone: 'Asia/Riyadh', isActive: true },
				],
			}),
		)
		expect(await getScopeFacts(ORG, 'loc_1', 1_000)).toBeNull()
	})
})

describe('staffing flags from the control plane', () => {
	const fetchMock = vi.fn()

	function withFeatures(
		features:
			| {
					enabled: boolean
					timeclock: boolean
					scheduling: boolean
					hiring: boolean
			  }
			| undefined,
		extra: Record<string, unknown> = {},
	) {
		return Response.json({
			orgId: ORG,
			scopes: [{ id: 'loc_1', name: 'Downtown', timeZone: 'America/Chicago' }],
			...(features ? { features } : {}),
			...extra,
		})
	}

	beforeEach(() => {
		resetScopeContextCache()
		fetchMock.mockReset()
		vi.stubGlobal('fetch', fetchMock)
		vi.stubEnv('APP_URL', 'https://app.example.test')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'x'.repeat(32))
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it('returns the flags and region the App reports', async () => {
		fetchMock.mockResolvedValue(
			withFeatures(
				{ enabled: true, timeclock: true, scheduling: false, hiring: false },
				{ dataRegion: 'ksa' },
			),
		)
		expect(await getStaffingFeatures(ORG, 1_000)).toEqual({
			features: {
				enabled: true,
				timeclock: true,
				scheduling: false,
				hiring: false,
			},
			dataRegion: 'ksa',
		})
	})

	it('treats an App that does not report flags as unknown, never as on', async () => {
		fetchMock.mockResolvedValue(withFeatures(undefined))
		expect(await getStaffingFeatures(ORG, 1_000)).toBeNull()
		// The scope facts from the same answer are still usable.
		expect(await getScopeFacts(ORG, 'loc_1', 2_000)).toEqual({
			name: 'Downtown',
			timeZone: 'America/Chicago',
		})
	})

	it('rejects a malformed flag block rather than guessing', async () => {
		fetchMock.mockResolvedValue(
			Response.json({
				orgId: ORG,
				scopes: [],
				features: {
					enabled: 'yes',
					timeclock: true,
					scheduling: true,
					hiring: false,
				},
			}),
		)
		expect(await getStaffingFeatures(ORG, 1_000)).toBeNull()
	})

	it('shares one lookup with the scope facts', async () => {
		fetchMock.mockResolvedValue(
			withFeatures({
				enabled: true,
				timeclock: true,
				scheduling: true,
				hiring: false,
			}),
		)
		await getScopeFacts(ORG, 'loc_1', 1_000)
		await getStaffingFeatures(ORG, 2_000)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('stops trusting flags that are too old when the App is unreachable', async () => {
		fetchMock.mockResolvedValueOnce(
			withFeatures({
				enabled: true,
				timeclock: true,
				scheduling: true,
				hiring: false,
			}),
		)
		expect(await getStaffingFeatures(ORG, 1_000)).not.toBeNull()
		fetchMock.mockRejectedValue(new Error('down'))
		// Ten minutes later: stale but inside the trust window.
		expect(await getStaffingFeatures(ORG, 1_000 + 10 * 60_000)).not.toBeNull()
		// An hour later: the flag may have been turned off, so nothing runs.
		expect(await getStaffingFeatures(ORG, 1_000 + 60 * 60_000)).toBeNull()
	})

	it('picks up a flag turned off once the cache expires', async () => {
		fetchMock.mockResolvedValueOnce(
			withFeatures({
				enabled: true,
				timeclock: true,
				scheduling: true,
				hiring: false,
			}),
		)
		expect((await getStaffingFeatures(ORG, 1_000))?.features.enabled).toBe(true)
		fetchMock.mockResolvedValueOnce(
			withFeatures({
				enabled: false,
				timeclock: false,
				scheduling: false,
				hiring: false,
			}),
		)
		expect(
			(await getStaffingFeatures(ORG, 1_000 + 6 * 60_000))?.features.enabled,
		).toBe(false)
	})
})
