import { db, eq, LocationOrderingPause, OrganizationLocation } from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { loadOrderingControls, applyOrderingControl } from './ordering-controls.server.ts'
import { loadPauseHistory } from './ordering-pause-history.server.ts'

vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: vi.fn(async () => false),
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(true),
}))

const MIN = 60_000

async function setup() {
	const { organization, user } = await setupTestOrgWithUser('admin')
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Main Street',
			slug: `main-${Math.random().toString(36).slice(2)}`,
			timezone: 'America/New_York',
		})
		.returning()
	return { organization, user, location: location! }
}

async function rows(locationId: string) {
	return db
		.select()
		.from(LocationOrderingPause)
		.where(eq(LocationOrderingPause.locationId, locationId))
}

describe('ordering pause history (#176, #405)', () => {
	beforeEach(() => vi.clearAllMocks())
	afterEach(() => vi.useRealTimers())

	function control(
		organization: { id: string; slug: string },
		userId: string | null,
		input: Parameters<typeof applyOrderingControl>[0]['control'],
		options: { now?: Date; source?: Parameters<typeof applyOrderingControl>[0]['source']; bulk?: { size: number } } = {},
	) {
		return applyOrderingControl({
			organization,
			userId,
			control: input,
			request: new Request('https://app.test/orders'),
			...options,
		})
	}

	it('records a pause start and its end when it is resumed', async () => {
		const { organization, user, location } = await setup()
		const start = new Date(Date.now() - 100 * MIN)
		await control(
			organization,
			user.id,
			{ intent: 'pause', locationId: location.id, duration: '60m' },
			{ now: start },
		)
		let history = await rows(location.id)
		expect(history).toHaveLength(1)
		expect(history[0]).toMatchObject({
			kind: 'pause',
			startedBy: user.id,
			source: 'app',
			endedAt: null,
		})
		expect(history[0]!.startedAt.getTime()).toBe(start.getTime())
		expect(history[0]!.plannedUntil!.getTime()).toBe(start.getTime() + 60 * MIN)

		const resumeAt = new Date(start.getTime() + 20 * MIN)
		await control(
			organization,
			user.id,
			{ intent: 'resume', locationId: location.id },
			{ now: resumeAt },
		)
		history = await rows(location.id)
		expect(history).toHaveLength(1)
		expect(history[0]!.endedAt!.getTime()).toBe(resumeAt.getTime())
		expect(history[0]!.endedBy).toBe('member')
	})

	it('records the end of a pause that ran out by itself, at its own planned end, on the next read', async () => {
		const { organization, user, location } = await setup()
		const start = new Date(Date.now() - 3 * 60 * MIN)
		await control(
			organization,
			user.id,
			{ intent: 'pause', locationId: location.id, duration: '30m' },
			{ now: start },
		)
		expect((await rows(location.id))[0]!.endedAt).toBeNull()
		// Nobody resumed; the next read fills the end.
		await loadOrderingControls(organization.id, new Date())
		const [row] = await rows(location.id)
		expect(row!.endedBy).toBe('auto_expiry')
		expect(row!.endedAt!.getTime()).toBe(start.getTime() + 30 * MIN)
	})

	it('a new pause replaces the one in force and a station pause says so', async () => {
		const { organization, user, location } = await setup()
		const first = new Date(Date.now() - 50 * MIN)
		await control(
			organization,
			user.id,
			{ intent: 'pause', locationId: location.id, duration: 'until_resumed' },
			{ now: first },
		)
		const second = new Date(first.getTime() + 10 * MIN)
		await control(
			organization,
			null,
			{ intent: 'pause', locationId: location.id, duration: '15m' },
			{
				now: second,
				source: { kind: 'station', deviceId: 'dev_1', staffId: 'staff_1' },
			},
		)
		const history = (await rows(location.id)).sort(
			(a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
		)
		expect(history.map((row) => [row.endedBy, row.source])).toEqual([
			['replaced', 'app'],
			[null, 'station'],
		])
		expect(history[0]!.endedAt!.getTime()).toBe(second.getTime())
		expect(history[1]!.startedBy).toBeNull()
	})

	it('never records busy mode, so it can never become a missed estimate', async () => {
		const { organization, user, location } = await setup()
		await control(organization, user.id, {
			intent: 'busy',
			locationId: location.id,
			minutes: 20,
			duration: '30m',
		})
		await control(organization, user.id, {
			intent: 'busy_off',
			locationId: location.id,
		})
		expect(await rows(location.id)).toHaveLength(0)
	})

	it('gives a pause already running when the history began its row on the next read', async () => {
		const { organization, location } = await setup()
		const pausedAt = new Date(Date.now() - 10 * MIN)
		await db
			.update(OrganizationLocation)
			.set({
				orderingPausedAt: pausedAt,
				orderingPausedUntil: new Date(Date.now() + 20 * MIN),
			})
			.where(eq(OrganizationLocation.id, location.id))
		await loadOrderingControls(organization.id, new Date())
		await loadOrderingControls(organization.id, new Date())
		const history = await rows(location.id)
		expect(history).toHaveLength(1)
		expect(history[0]!.startedAt.getTime()).toBe(pausedAt.getTime())
		expect(history[0]!.endedAt).toBeNull()
	})

	it('lists the rows that touch a range and keeps another organization out', async () => {
		const { organization, user, location } = await setup()
		const other = await setup()
		await control(
			organization,
			user.id,
			{ intent: 'pause', locationId: location.id, duration: '15m' },
			{ now: new Date(Date.now() - 5 * 86_400_000) },
		)
		const history = await loadPauseHistory(organization.id, {
			from: new Date(Date.now() - 7 * 86_400_000),
			to: new Date(),
		})
		expect(history).toHaveLength(1)
		expect(
			await loadPauseHistory(other.organization.id, {
				from: new Date(Date.now() - 7 * 86_400_000),
				to: new Date(),
			}),
		).toHaveLength(0)
		// A range after the pause ended holds nothing.
		expect(
			await loadPauseHistory(organization.id, {
				from: new Date(Date.now() - 3 * 86_400_000),
				to: new Date(),
			}),
		).toHaveLength(0)
	})
})
