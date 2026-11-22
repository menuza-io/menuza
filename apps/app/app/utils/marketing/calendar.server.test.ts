import { db, eq, Organization, OrganizationLocation } from '@repo/database'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import {
	dismissOccasion,
	loadCalendar,
	occasionDraft,
	recommendedSendAt,
	restoreOccasion,
	setAutoSchedule,
	setMarketingMarket,
} from './calendar.server.ts'

/**
 * #152: what the calendar shows for the organization's market four weeks ahead,
 * what each choice does, and the prefilled broadcast "Use this" opens.
 */

let userId: string
beforeAll(async () => {
	userId = (await createTestUser()).id
})

async function org(values: Partial<typeof Organization.$inferInsert> = {}) {
	const organization = await createTestOrganization(userId)
	await db
		.update(Organization)
		.set({ dataRegion: 'us', name: 'Casa Verde', ...values })
		.where(eq(Organization.id, organization.id))
	return organization.id
}

const noBroadcasts = vi.fn(async () => Response.json({ campaigns: [] }))
const NOW = Date.UTC(2026, 3, 20, 12)

function calendar(
	organizationId: string,
	over: Partial<Parameters<typeof loadCalendar>[0]> = {},
) {
	return loadCalendar({
		organizationId,
		month: '2026-05',
		today: '2026-04-20',
		timeZone: 'UTC',
		fetchTenant: noBroadcasts,
		now: NOW,
		...over,
	})
}

describe('the marketing calendar (#152)', () => {
	it("shows the market's occasions four weeks ahead, each with ready-made words", async () => {
		const id = await org()
		const data = await calendar(id)
		expect(data.market).toBe('us')
		expect(data.suggestions.map((o) => [o.key, o.date])).toEqual([
			['us_mothers_day', '2026-05-10'],
		])
		const mothers = data.suggestions[0]!
		expect(mothers.preview.subject).toBe("Mother's Day at Casa Verde")
		expect(mothers.preview.sms).toContain('Casa Verde')
		expect(mothers.status).toBe('open')
		expect(mothers.expected).toBe(false)
		// The month grid holds the same occasion on its day.
		expect(data.occasions.find((o) => o.key === 'us_mothers_day')?.date).toBe(
			'2026-05-10',
		)
	})

	it('a Saudi organization sees Saudi occasions, Hijri ones marked expected', async () => {
		const id = await org({ dataRegion: 'ksa' })
		const data = await calendar(id, {
			month: '2026-02',
			today: '2026-02-01',
			now: Date.UTC(2026, 1, 1, 12),
		})
		expect(data.market).toBe('ksa')
		expect(data.suggestions.map((o) => [o.key, o.date, o.expected])).toEqual([
			['ksa_ramadan_start', '2026-02-18', true],
			['ksa_founding_day', '2026-02-22', false],
		])
	})

	it('Marketing settings can override the market (a US restaurant that wants Ramadan)', async () => {
		const id = await org()
		expect(
			await setMarketingMarket({ organizationId: id, market: 'ksa' }),
		).toBe(true)
		const data = await calendar(id, {
			month: '2026-02',
			today: '2026-02-01',
			now: Date.UTC(2026, 1, 1, 12),
		})
		expect(data.market).toBe('ksa')
		expect(data.suggestions[0]?.key).toBe('ksa_ramadan_start')
		// Back to following the region; nonsense is refused.
		expect(await setMarketingMarket({ organizationId: id, market: null })).toBe(
			true,
		)
		expect((await calendar(id)).market).toBe('us')
		expect(
			await setMarketingMarket({ organizationId: id, market: 'mars' }),
		).toBe(false)
	})

	it('a dismissed occasion leaves the suggestions for that year only, and can be restored', async () => {
		const id = await org()
		await dismissOccasion({
			organizationId: id,
			key: 'us_mothers_day',
			year: 2026,
		})
		expect((await calendar(id)).suggestions).toEqual([])
		// Still on the month grid, marked dismissed.
		expect(
			(await calendar(id)).occasions.find((o) => o.key === 'us_mothers_day')
				?.status,
		).toBe('dismissed')
		// Next year's is a new occasion.
		const next = await calendar(id, {
			month: '2027-05',
			today: '2027-04-20',
			now: Date.UTC(2027, 3, 20, 12),
		})
		expect(next.suggestions[0]).toMatchObject({
			key: 'us_mothers_day',
			status: 'open',
		})
		await restoreOccasion({
			organizationId: id,
			key: 'us_mothers_day',
			year: 2026,
		})
		expect((await calendar(id)).suggestions).toHaveLength(1)
		expect(
			await dismissOccasion({
				organizationId: id,
				key: 'nonsense',
				year: 2026,
			}),
		).toBe(false)
	})

	it('Auto-schedule is off until turned on, and remembers its channel', async () => {
		const id = await org()
		expect((await calendar(id)).suggestions[0]).toMatchObject({
			autoSchedule: false,
			autoChannel: 'email',
		})
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: true,
			channel: 'sms',
		})
		expect((await calendar(id)).suggestions[0]).toMatchObject({
			autoSchedule: true,
			autoChannel: 'sms',
		})
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: false,
		})
		expect((await calendar(id)).suggestions[0]?.autoSchedule).toBe(false)
		expect(
			await setAutoSchedule({ organizationId: id, key: 'nope', on: true }),
		).toBe(false)
	})

	it("puts the organization's scheduled broadcasts on the grid, from the region's list", async () => {
		const id = await org()
		const fetchTenant = vi.fn(async () =>
			Response.json({
				campaigns: [
					{
						id: 'c1',
						name: 'Brunch',
						channel: 'email',
						status: 'Scheduled',
						scheduledAt: Date.UTC(2026, 4, 3, 10),
						createdAt: 1,
					},
					{
						id: 'c2',
						name: 'Old',
						channel: 'sms',
						status: 'Completed',
						scheduledAt: null,
						createdAt: Date.UTC(2026, 3, 30, 10),
					},
					{
						id: 'c3',
						name: 'Draft',
						channel: 'email',
						status: 'Draft',
						scheduledAt: Date.UTC(2026, 4, 4, 10),
					},
					{
						id: 'c4',
						name: 'Far',
						channel: 'email',
						status: 'Scheduled',
						scheduledAt: Date.UTC(2027, 4, 4, 10),
					},
				],
			}),
		)
		const data = await calendar(id, { fetchTenant })
		expect(data.broadcasts.map((b) => [b.id, b.channel, b.status])).toEqual([
			['c2', 'sms', 'Completed'],
			['c1', 'email', 'Scheduled'],
		])
		// A region that cannot answer shows none, not an error.
		const down = await calendar(id, {
			fetchTenant: vi.fn(async () => new Response('no', { status: 500 })),
		})
		expect(down.broadcasts).toEqual([])
	})

	it('"Use this" opens the occasion\'s own design, text and time, only for a real date of the market', async () => {
		const id = await org()
		const draft = await occasionDraft({
			organizationId: id,
			key: 'us_mothers_day',
			date: '2026-05-10',
			now: NOW,
		})
		expect(draft).not.toBeNull()
		expect(draft!.message.name).toBe("Mother's Day 2026")
		expect(draft!.message.blocks.map((b) => b.type)).toEqual([
			'heading',
			'body',
			'button',
		])
		expect(new Date(draft!.sendAt).toISOString()).toBe(
			'2026-04-30T10:00:00.000Z',
		)
		// A made-up date, another market's occasion and a made-up key give nothing.
		expect(
			await occasionDraft({
				organizationId: id,
				key: 'us_mothers_day',
				date: '2026-05-11',
				now: NOW,
			}),
		).toBeNull()
		expect(
			await occasionDraft({
				organizationId: id,
				key: 'ksa_national_day',
				date: '2026-09-23',
				now: NOW,
			}),
		).toBeNull()
		expect(
			await occasionDraft({
				organizationId: id,
				key: 'nope',
				date: '2026-05-10',
				now: NOW,
			}),
		).toBeNull()
		expect(
			await occasionDraft({
				organizationId: id,
				key: 'us_mothers_day',
				date: 'soon',
				now: NOW,
			}),
		).toBeNull()
	})

	it('is written in the site language', async () => {
		const id = await org({ siteDefaultLocale: 'fr' })
		const data = await calendar(id)
		expect(data.siteLocale).toBe('fr')
		expect(data.suggestions[0]!.preview.subject).toBe(
			'Fête des mères chez Casa Verde',
		)
	})

	it("the recommended time is 10:00 in the location's zone, and never in the past", async () => {
		// 10:00 in New York on 30 April is 14:00 UTC.
		expect(
			new Date(
				recommendedSendAt('2026-04-30', 'America/New_York', NOW),
			).toISOString(),
		).toBe('2026-04-30T14:00:00.000Z')
		// A send date that already passed moves to the next 10:00 at least an hour ahead.
		const late = recommendedSendAt('2026-04-19', 'UTC', NOW)
		expect(late).toBeGreaterThanOrEqual(NOW + 3_600_000)
		expect(new Date(late).getUTCHours()).toBe(10)
	})

	it("uses the first location's time zone", async () => {
		const id = await org()
		await db.insert(OrganizationLocation).values({
			organizationId: id,
			name: 'Downtown',
			slug: 'downtown',
			timezone: 'America/New_York',
		})
		const data = await calendar(id)
		expect(data.suggestions[0]!.sendAt).toBe('2026-04-30T14:00:00.000Z')
	})
})
