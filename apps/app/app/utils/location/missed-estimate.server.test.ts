import { db, LocationOrderingPause, OrganizationLocation } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { loadMissedPlanEntries } from './missed-estimate.server.ts'
import { applyOrderingControl } from './ordering-controls.server.ts'

vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: vi.fn(async () => false),
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(true),
}))

const HOUR = 3_600_000
const DAY = 24 * HOUR
const DAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
]
const allDay = JSON.stringify(
	DAYS.map((day) => ({ day, isOpen: true, slots: [{ start: '00:00', end: '23:59' }] })),
)

async function setup() {
	const { organization, user } = await setupTestOrgWithUser('admin')
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Main Street',
			slug: `main-${Math.random().toString(36).slice(2)}`,
			timezone: 'UTC',
			storeHours: allDay,
		})
		.returning()
	return { organization, user, location: location! }
}

describe('windows to estimate for a pause (#176)', () => {
	it('after a 2 hour pause, plans the same window of the previous four weeks', async () => {
		const { organization, user, location } = await setup()
		const now = new Date()
		const start = new Date(now.getTime() - 3 * HOUR)
		await applyOrderingControl({
			organization,
			userId: user.id,
			control: { intent: 'pause', locationId: location.id, duration: 'until_resumed' },
			request: new Request('https://app.test/'),
			now: start,
		})
		// Resumed after 2 hours.
		await applyOrderingControl({
			organization,
			userId: user.id,
			control: { intent: 'resume', locationId: location.id },
			request: new Request('https://app.test/'),
			now: new Date(start.getTime() + 2 * HOUR),
		})
		const entries = await loadMissedPlanEntries(organization.id, {
			now,
			mode: { kind: 'latest', withinDays: 14 },
			locationIds: null,
		})
		expect(entries).toHaveLength(1)
		const entry = entries[0]!
		expect(entry).toMatchObject({
			locationId: location.id,
			current: false,
			minutesPaused: 120,
			currency: 'USD',
		})
		expect(entry.plans).toHaveLength(1)
		expect(entry.plans[0]!.weeks).toHaveLength(4)
		for (const [index, week] of entry.plans[0]!.weeks.entries()) {
			// The same window, one to four weeks earlier.
			expect(entry.plans[0]!.from - week.from).toBeGreaterThanOrEqual(
				(index + 1) * 7 * DAY - HOUR,
			)
			expect(week.to - week.from).toBe(2 * HOUR)
		}
	})

	it('leaves a week out when that window was paused too, and has fewer than two weeks to show none', async () => {
		const { organization, user, location } = await setup()
		const now = new Date()
		const start = new Date(now.getTime() - 3 * HOUR)
		await applyOrderingControl({
			organization,
			userId: user.id,
			control: { intent: 'pause', locationId: location.id, duration: 'until_resumed' },
			request: new Request('https://app.test/'),
			now: start,
		})
		// Paused at the same hour in three of the four earlier weeks.
		await db.insert(LocationOrderingPause).values(
			[1, 2, 3].map((week) => ({
				organizationId: organization.id,
				locationId: location.id,
				kind: 'pause',
				startedAt: new Date(start.getTime() - week * 7 * DAY),
				plannedUntil: new Date(start.getTime() - week * 7 * DAY + HOUR),
				endedAt: new Date(start.getTime() - week * 7 * DAY + HOUR),
				endedBy: 'member',
				source: 'app',
			})),
		)
		const [entry] = await loadMissedPlanEntries(organization.id, {
			now,
			mode: { kind: 'latest', withinDays: 14 },
			locationIds: null,
		})
		expect(entry!.current).toBe(true)
		// One usable week: the region will answer "not enough history yet".
		expect(entry!.plans[0]!.weeks).toHaveLength(1)
		expect(entry!.plans[0]!.weeksSkipped).toBe(3)
	})

	it('never plans anything for busy mode, and only for the member\'s locations', async () => {
		const { organization, user, location } = await setup()
		await applyOrderingControl({
			organization,
			userId: user.id,
			control: { intent: 'busy', locationId: location.id, minutes: 20, duration: '60m' },
			request: new Request('https://app.test/'),
		})
		const options = {
			now: new Date(),
			mode: { kind: 'latest' as const, withinDays: 14 },
		}
		expect(
			await loadMissedPlanEntries(organization.id, { ...options, locationIds: null }),
		).toEqual([])
		// A real pause, then asked for by someone limited to another location.
		await applyOrderingControl({
			organization,
			userId: user.id,
			control: { intent: 'pause', locationId: location.id, duration: 'until_resumed' },
			request: new Request('https://app.test/'),
			now: new Date(Date.now() - 2 * HOUR),
		})
		expect(
			await loadMissedPlanEntries(organization.id, {
				...options,
				locationIds: ['someone-elses-location'],
			}),
		).toEqual([])
		expect(
			await loadMissedPlanEntries(organization.id, {
				...options,
				locationIds: [location.id],
			}),
		).toHaveLength(1)
	})

	it("lists today's pauses from each location's own midnight", async () => {
		const { organization, user, location } = await setup()
		await applyOrderingControl({
			organization,
			userId: user.id,
			control: { intent: 'pause', locationId: location.id, duration: '15m' },
			request: new Request('https://app.test/'),
			now: new Date(Date.now() - 20 * 60_000),
		})
		const entries = await loadMissedPlanEntries(organization.id, {
			now: new Date(),
			mode: { kind: 'today' },
			locationIds: null,
		})
		expect(entries.length).toBeLessThanOrEqual(1)
		// Yesterday's pause is not today's.
		const other = await setup()
		await applyOrderingControl({
			organization: other.organization,
			userId: other.user.id,
			control: { intent: 'pause', locationId: other.location.id, duration: '15m' },
			request: new Request('https://app.test/'),
			now: new Date(Date.now() - 40 * HOUR),
		})
		expect(
			await loadMissedPlanEntries(other.organization.id, {
				now: new Date(),
				mode: { kind: 'today' },
				locationIds: null,
			}),
		).toEqual([])
	})
})
