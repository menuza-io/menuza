import {
	db,
	eq,
	MarketingOccasionChoice,
	Notification,
	Organization,
} from '@repo/database'
import { addDays } from '@repo/marketing/occasions'
import {
	getSmsAllowance,
	reserveSmsSend,
} from '@repo/marketing/server/sms-allowance'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { dismissOccasion, setAutoSchedule } from './calendar.server.ts'
import {
	nextOccasionRun,
	runOccasionAutoSchedule,
	type OccasionJobDeps,
} from './occasion-schedule.server.ts'

const sendEmailMock = vi.hoisted(() =>
	vi.fn(async () => ({ status: 'success' })),
)
vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<object>()),
	sendEmail: sendEmailMock,
}))

/**
 * #152: the daily occasion job. Only occasions with Auto-schedule on, 14 days
 * ahead, once per year; a conflict or an empty allowance skips and says so.
 */

// 28 April 2026: Mother's Day (10 May) is 12 days away, Father's Day is not near.
const NOW = Date.UTC(2026, 3, 28, 12)
let userId: string

beforeAll(async () => {
	userId = (await createTestUser()).id
})
afterEach(() => vi.clearAllMocks())

async function org(
	values: Partial<typeof Organization.$inferInsert> = {},
	enabled = true,
) {
	const organization = await createTestOrganization(userId)
	await db
		.update(Organization)
		.set({
			dataRegion: 'us',
			hasProvisionedDb: true,
			name: 'Casa Verde',
			...values,
		})
		.where(eq(Organization.id, organization.id))
	return { id: organization.id, slug: organization.slug, enabled }
}

function deps(
	overrides: Partial<OccasionJobDeps> = {},
	enabledIds: string[] | 'all' = 'all',
) {
	const created: Array<Record<string, unknown>> = []
	const notified: Array<Record<string, unknown>> = []
	const value: Partial<OccasionJobDeps> = {
		isEnabled: async (id) => enabledIds === 'all' || enabledIds.includes(id),
		createCampaign: async (_org, payload) => {
			created.push(payload)
			return { status: 'created', campaignId: `camp_${created.length}` }
		},
		notify: async (input) => {
			notified.push(input)
		},
		...overrides,
	}
	return { deps: value, created, notified }
}

const choiceOf = async (organizationId: string, key = 'us_mothers_day') =>
	(
		await db
			.select()
			.from(MarketingOccasionChoice)
			.where(eq(MarketingOccasionChoice.organizationId, organizationId))
	).find((row) => row.occasionKey === key)

describe('the occasion job (#152)', () => {
	it('schedules a broadcast for an occasion that is auto-scheduled and 14 days away, with its ready-made words', async () => {
		const { id } = await org()
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: true,
		})
		const { deps: d, created, notified } = deps({}, [id])

		const result = await runOccasionAutoSchedule({ now: NOW, deps: d })

		expect(result).toMatchObject({ scheduled: 1, skipped: 0, failed: 0 })
		expect(created).toHaveLength(1)
		const payload = created[0]!
		expect(payload).toMatchObject({
			name: "Mother's Day 2026",
			channel: 'email',
			subject: "Mother's Day at Casa Verde",
			occasionDate: '2026-05-10',
			conflictDays: 2,
			audienceId: null,
		})
		// A designed email in the organization's branding, frozen at schedule time.
		expect(String(payload.contentHtml)).toContain('Celebrate')
		expect(JSON.parse(String(payload.contentBlocks))).toHaveLength(3)
		// Scheduled for the recommended time: 10 days before, in the future.
		const sendAt = Date.parse(String(payload.scheduledAt))
		expect(sendAt).toBeGreaterThan(NOW)
		expect(new Date(sendAt).toISOString().slice(0, 10)).toBe('2026-04-30')
		// The operator is told, and the choice remembers the year and the broadcast.
		expect(notified).toEqual([
			expect.objectContaining({
				kind: 'scheduled',
				occasionKey: 'us_mothers_day',
				year: 2026,
				campaignId: 'camp_1',
			}),
		])
		expect(await choiceOf(id)).toMatchObject({
			scheduledYear: 2026,
			campaignId: 'camp_1',
		})
	})

	it('creates it once per year: a second run, and a run that races it, create nothing more', async () => {
		const { id } = await org()
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: true,
		})
		const { deps: d, created } = deps({}, [id])
		await runOccasionAutoSchedule({ now: NOW, deps: d })
		await runOccasionAutoSchedule({ now: NOW + 3_600_000, deps: d })
		await runOccasionAutoSchedule({ now: NOW + 3 * 86_400_000, deps: d })
		expect(created).toHaveLength(1)

		const second = await org()
		await setAutoSchedule({
			organizationId: second.id,
			key: 'us_mothers_day',
			on: true,
		})
		const raced = deps({}, [second.id])
		await Promise.all([
			runOccasionAutoSchedule({ now: NOW, deps: raced.deps }),
			runOccasionAutoSchedule({ now: NOW, deps: raced.deps }),
			runOccasionAutoSchedule({ now: NOW, deps: raced.deps }),
		])
		expect(raced.created).toHaveLength(1)

		// And again next year it is a new occasion.
		const nextYear = Date.UTC(2027, 3, 28, 12)
		await runOccasionAutoSchedule({ now: nextYear, deps: d })
		expect(created).toHaveLength(2)
		expect(created[1]).toMatchObject({ name: "Mother's Day 2027" })
	})

	it('never creates anything for an occasion the operator did not turn on', async () => {
		const { id } = await org()
		const { deps: d, created, notified } = deps({}, [id])
		// No choice at all, then a dismissal, then Auto-schedule switched off again.
		await runOccasionAutoSchedule({ now: NOW, deps: d })
		await dismissOccasion({
			organizationId: id,
			key: 'us_mothers_day',
			year: 2026,
		})
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: true,
		})
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: false,
		})
		await runOccasionAutoSchedule({ now: NOW, deps: d })
		expect(created).toEqual([])
		expect(notified).toEqual([])
	})

	it('does not schedule an occasion more than 14 days away, or one that already passed', async () => {
		const { id } = await org()
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: true,
		})
		const { deps: d, created } = deps({}, [id])
		// 20 days before Mother's Day: too early. The day after: gone.
		await runOccasionAutoSchedule({ now: Date.UTC(2026, 3, 20, 12), deps: d })
		await runOccasionAutoSchedule({ now: Date.UTC(2026, 4, 11, 12), deps: d })
		expect(created).toEqual([])
		// Exactly 14 days before is the moment.
		await runOccasionAutoSchedule({ now: Date.UTC(2026, 3, 26, 12), deps: d })
		expect(created).toHaveLength(1)
	})

	it('a dismissed occasion stays dismissed for that year only', async () => {
		const { id } = await org()
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: true,
		})
		await dismissOccasion({
			organizationId: id,
			key: 'us_mothers_day',
			year: 2026,
		})
		const { deps: d, created } = deps({}, [id])
		await runOccasionAutoSchedule({ now: NOW, deps: d })
		expect(created).toEqual([])
		await runOccasionAutoSchedule({ now: Date.UTC(2027, 3, 28, 12), deps: d })
		expect(created).toHaveLength(1)
	})

	it('another broadcast within 2 days is a conflict: nothing is created, the year is skipped, the operator is told', async () => {
		const { id } = await org()
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: true,
		})
		const {
			deps: d,
			created,
			notified,
		} = deps({ createCampaign: async () => ({ status: 'conflict' }) }, [id])
		const result = await runOccasionAutoSchedule({ now: NOW, deps: d })
		expect(result).toMatchObject({ scheduled: 0, skipped: 1 })
		expect(created).toEqual([])
		expect(notified).toEqual([
			expect.objectContaining({
				kind: 'skipped',
				reason: 'occasion_conflict',
				campaignId: null,
			}),
		])
		expect(await choiceOf(id)).toMatchObject({
			skippedYear: 2026,
			skipReason: 'occasion_conflict',
			scheduledYear: null,
		})
		// Not tried again (or told again) this year.
		await runOccasionAutoSchedule({ now: NOW + 86_400_000, deps: d })
		expect(notified).toHaveLength(1)
	})

	it('a region that fails is tried again on the next run, not marked done', async () => {
		const { id } = await org()
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: true,
		})
		let fail = true
		const { deps: d, notified } = deps(
			{
				createCampaign: async () =>
					fail
						? { status: 'failed' }
						: { status: 'created', campaignId: 'camp_late' },
			},
			[id],
		)
		const first = await runOccasionAutoSchedule({ now: NOW, deps: d })
		expect(first).toMatchObject({ scheduled: 0, failed: 1 })
		expect(await choiceOf(id)).toMatchObject({ scheduledYear: null })
		fail = false
		const second = await runOccasionAutoSchedule({
			now: NOW + 3_600_000,
			deps: d,
		})
		expect(second.scheduled).toBe(1)
		expect(notified).toHaveLength(1)
	})

	it('an organization without the marketing.calendar flag is left alone', async () => {
		const { id } = await org()
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: true,
		})
		const { deps: d, created } = deps({}, [])
		await runOccasionAutoSchedule({ now: NOW, deps: d })
		expect(created).toEqual([])
		expect(await choiceOf(id)).toMatchObject({ scheduledYear: null })
	})

	it('follows the market: a KSA organization gets Hijri occasions, with their expected dates', async () => {
		const { id } = await org({ dataRegion: 'ksa' })
		await setAutoSchedule({
			organizationId: id,
			key: 'ksa_ramadan_start',
			on: true,
		})
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: true,
		})
		const { deps: d, created } = deps({}, [id])
		// 6 February 2026: Ramadan is expected on 18 February.
		await runOccasionAutoSchedule({ now: Date.UTC(2026, 1, 6, 12), deps: d })
		expect(created).toHaveLength(1)
		expect(created[0]).toMatchObject({
			name: 'Start of Ramadan 2026',
			occasionDate: '2026-02-18',
		})
		// The US occasion is not of this market, even when someone turned it on.
		await runOccasionAutoSchedule({ now: NOW, deps: d })
		expect(created).toHaveLength(1)
	})

	it('a text occasion is a text, and waits when no text sends are left', async () => {
		const { id } = await org()
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: true,
			channel: 'sms',
		})
		const { deps: d, created } = deps({}, [id])
		await runOccasionAutoSchedule({ now: NOW, deps: d })
		expect(created[0]).toMatchObject({ channel: 'sms', subject: null })
		expect(String(created[0]!.content)).toContain('Casa Verde')
		expect(created[0]!.contentHtml).toBeUndefined()
	})

	it('a text occasion is skipped, and the operator told, when no text sends are left that month', async () => {
		const { id } = await org()
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: true,
			channel: 'sms',
		})
		for (let i = 0; i < 4; i++) {
			await reserveSmsSend({
				organizationId: id,
				campaignId: `held_${id}_${i}`,
				startsAtMs: Date.UTC(2026, 3, 30, 10),
			})
		}
		const { deps: d, created, notified } = deps({}, [id])
		const result = await runOccasionAutoSchedule({ now: NOW, deps: d })
		expect(result).toMatchObject({ scheduled: 0, skipped: 1 })
		expect(created).toEqual([])
		expect(notified).toEqual([
			expect.objectContaining({ kind: 'skipped', reason: 'sms_allowance' }),
		])
	})

	it('a text occasion holds a send of the month once it is scheduled', async () => {
		const { id } = await org()
		await setAutoSchedule({
			organizationId: id,
			key: 'us_mothers_day',
			on: true,
			channel: 'sms',
		})
		const { deps: d } = deps(
			{
				createCampaign: async () => ({
					status: 'created',
					campaignId: `camp_sms_${id}`,
				}),
			},
			[id],
		)
		await runOccasionAutoSchedule({ now: NOW, deps: d })
		expect((await getSmsAllowance(id, Date.UTC(2026, 3, 30, 10))).used).toBe(1)
	})

	it('tells the operator in the bell, once, and by email', async () => {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id)
		await db
			.update(Organization)
			.set({ dataRegion: 'us', hasProvisionedDb: true, name: 'Casa Verde' })
			.where(eq(Organization.id, organization.id))
		await setAutoSchedule({
			organizationId: organization.id,
			key: 'us_mothers_day',
			on: true,
		})
		const { deps: d } = deps({ notify: undefined }, [organization.id])
		delete d.notify
		await runOccasionAutoSchedule({ now: NOW, deps: d })
		await runOccasionAutoSchedule({ now: NOW + 3_600_000, deps: d })
		const rows = await db
			.select()
			.from(Notification)
			.where(eq(Notification.organizationId, organization.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			type: 'marketing-occasion-scheduled',
			entityId: 'us_mothers_day:2026',
			userId: user.id,
		})
		expect(JSON.parse(rows[0]!.payload)).toMatchObject({
			orgSlug: organization.slug,
			occasionKey: 'us_mothers_day',
			campaignId: 'camp_1',
		})
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
	})
})

describe('the daily wake-up', () => {
	it('is 06:00 UTC, strictly after now', () => {
		expect(nextOccasionRun(Date.UTC(2026, 3, 28, 5, 59)).toISOString()).toBe(
			'2026-04-28T06:00:00.000Z',
		)
		expect(nextOccasionRun(Date.UTC(2026, 3, 28, 6, 0)).toISOString()).toBe(
			'2026-04-29T06:00:00.000Z',
		)
		expect(addDays('2026-04-28', 1)).toBe('2026-04-29')
	})
})
