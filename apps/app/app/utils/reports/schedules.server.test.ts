import {
	and,
	ConfigFlag,
	db,
	eq,
	Notification,
	Organization,
	OrganizationLocation,
	ReportSchedule,
	ReportScheduleRecipient,
	SavedReport,
	UserOrganization,
} from '@repo/database'
import { createReportDefinition } from '@repo/reports'
import { reportSendResponseSchema } from '@repo/reports/send-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	applyReportUnsubscribe,
	reportUnsubscribeUrl,
} from './report-unsubscribe.server.ts'
import {
	createReportSchedule,
	deleteReportSchedule,
	listReportSchedules,
	runDueReportSchedules,
	setReportSchedulePaused,
	updateReportSchedule,
} from './schedules.server.ts'

/**
 * Scheduled report emails, App side (#121): the rules (caps, members only,
 * personal fields), the hourly job (due time in the reporting zone, once a
 * day, grant re-check, retries, auto-pause) and one-click unsubscribe. The
 * region is a fake: nothing leaves the process.
 */

const request = new Request('http://localhost:3000/')

function salesReport(title = 'Net sales') {
	return createReportDefinition({
		subject: 'sales',
		timeframe: { field: 'occurredAt', preset: 'yesterday' },
		visualization: {
			chartStyle: 'single_number',
			measure: 'sum',
			valueField: 'netSales',
		},
		settings: { title, timezone: 'user' },
	})
}

function phoneReport() {
	return createReportDefinition({
		subject: 'orders',
		timeframe: { field: 'createdAt', preset: 'yesterday' },
		columns: ['number', 'customerPhone'],
		visualization: { chartStyle: 'table' },
		settings: { title: 'Orders with phones', timezone: 'user' },
	})
}

let flagId: string | null = null
const NOW = new Date('2027-01-05T14:00:00Z') // 08:00 in Chicago (CST)

async function setup() {
	const { user, organization } = await setupTestOrgWithUser('admin')
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true, dataRegion: 'us' })
		.where(eq(Organization.id, organization.id))
	await db.insert(OrganizationLocation).values({
		organizationId: organization.id,
		name: 'Main',
		slug: 'main',
		timezone: 'America/Chicago',
	} as never)
	const [flag] = await db
		.insert(ConfigFlag)
		.values({
			key: 'reports.schedules',
			value: true,
			level: 'organization',
			organizationId: organization.id,
		})
		.returning({ id: ConfigFlag.id })
	flagId = flag!.id
	const [report] = await db
		.insert(SavedReport)
		.values({
			scope: 'organization',
			organizationId: organization.id,
			createdById: user.id,
			title: 'Net sales',
			notes: '',
			definition: JSON.stringify(salesReport()),
		})
		.returning()
	return { user, organization, report: report! }
}

const baseInput = (savedReportId: string | null, recipientUserIds: string[]) => ({
	cadence: 'daily' as const,
	weekday: null,
	hour: 8,
	timeZone: 'America/Chicago',
	savedReportId,
	recipientUserIds,
	locale: 'en' as const,
})

function fakeRegion(
	statusFor: (userId: string) => 'sent' | 'failed' | 'skipped_no_access' = () => 'sent',
) {
	const calls: Array<{ path: string; body: Record<string, any> }> = []
	const post = vi.fn(async (input: { path: string; body: Record<string, unknown> }) => {
		calls.push({ path: input.path, body: input.body as Record<string, any> })
		const recipients = input.body.recipients as Array<{ userId: string }>
		return Response.json(
			reportSendResponseSchema.parse({
				results: recipients.map((r) => ({
					userId: r.userId,
					status: statusFor(r.userId),
					...(statusFor(r.userId) === 'failed' ? { reason: 'email_error' } : {}),
				})),
			}),
		)
	})
	return { post: post as never, calls }
}

async function backdate(scheduleId: string) {
	await db
		.update(ReportSchedule)
		.set({ createdAt: new Date('2026-01-01T00:00:00Z') })
		.where(eq(ReportSchedule.id, scheduleId))
}

afterEach(async () => {
	if (flagId) await db.delete(ConfigFlag).where(eq(ConfigFlag.id, flagId))
	flagId = null
	// The job reads every organization's schedules: leave none for the next test.
	await db.delete(ReportSchedule)
})

describe('creating a schedule (#121)', () => {
	it('is behind the flag, takes members only and refuses personal fields', async () => {
		const { user, organization, report } = await setup()
		const stranger = await createTestUser()
		expect(
			await createReportSchedule({
				organizationId: organization.id,
				userId: user.id,
				request,
				schedule: baseInput(report.id, [stranger.id]),
			}),
		).toMatchObject({ ok: false, error: 'invalid_recipient' })

		const [personal] = await db
			.insert(SavedReport)
			.values({
				scope: 'organization',
				organizationId: organization.id,
				createdById: user.id,
				title: 'Orders with phones',
				notes: '',
				definition: JSON.stringify(phoneReport()),
			})
			.returning()
		expect(
			await createReportSchedule({
				organizationId: organization.id,
				userId: user.id,
				request,
				schedule: baseInput(personal!.id, [user.id]),
			}),
		).toMatchObject({
			ok: false,
			error: 'report_has_personal_fields',
			detail: ['orders.customerPhone'],
		})

		const ok = await createReportSchedule({
			organizationId: organization.id,
			userId: user.id,
			request,
			schedule: baseInput(report.id, [user.id]),
		})
		expect(ok.ok).toBe(true)

		await db.delete(ConfigFlag).where(eq(ConfigFlag.id, flagId!))
		flagId = null
		expect(
			await createReportSchedule({
				organizationId: organization.id,
				userId: user.id,
				request,
				schedule: baseInput(report.id, [user.id]),
			}),
		).toMatchObject({ ok: false, error: 'feature_off' })
	})

	it('allows 10 schedules per organization and 20 recipients per schedule', async () => {
		const { user, organization, report } = await setup()
		for (let i = 0; i < 10; i += 1) {
			expect(
				(
					await createReportSchedule({
						organizationId: organization.id,
						userId: user.id,
						request,
						schedule: baseInput(report.id, [user.id]),
					})
				).ok,
			).toBe(true)
		}
		expect(
			await createReportSchedule({
				organizationId: organization.id,
				userId: user.id,
				request,
				schedule: baseInput(report.id, [user.id]),
			}),
		).toMatchObject({ ok: false, error: 'too_many_schedules' })

		const many: string[] = []
		for (let i = 0; i < 21; i += 1) many.push((await createTestUser()).id)
		const { organization: other, user: owner } = await setup()
		expect(
			await createReportSchedule({
				organizationId: other.id,
				userId: owner.id,
				request,
				schedule: baseInput(null, many),
			}),
		).toMatchObject({ ok: false, error: 'too_many_recipients' })
	})

	it('lists, pauses, edits and deletes', async () => {
		const { user, organization, report } = await setup()
		const created = await createReportSchedule({
			organizationId: organization.id,
			userId: user.id,
			request,
			schedule: baseInput(report.id, [user.id]),
		})
		if (!created.ok) throw new Error('create failed')
		let [row] = await listReportSchedules(organization.id)
		expect(row).toMatchObject({ title: 'Net sales', cadence: 'daily', hour: 8 })
		expect(row!.recipients).toHaveLength(1)

		await setReportSchedulePaused({
			organizationId: organization.id,
			scheduleId: created.data.id,
			paused: true,
		})
		;[row] = await listReportSchedules(organization.id)
		expect(row!.pausedAt).not.toBeNull()

		const edited = await updateReportSchedule({
			organizationId: organization.id,
			userId: user.id,
			request,
			scheduleId: created.data.id,
			schedule: { ...baseInput(null, [user.id]), hour: 6, cadence: 'weekly', weekday: 1 },
		})
		expect(edited.ok).toBe(true)
		;[row] = await listReportSchedules(organization.id)
		expect(row).toMatchObject({ hour: 6, cadence: 'weekly', weekday: 1 })

		await deleteReportSchedule({
			organizationId: organization.id,
			scheduleId: created.data.id,
		})
		expect(await listReportSchedules(organization.id)).toEqual([])
		// Another organization's schedule is out of reach.
		expect(
			await deleteReportSchedule({
				organizationId: 'someone-else',
				scheduleId: created.data.id,
			}),
		).toMatchObject({ ok: false, error: 'not_found' })
	})
})

describe('the hourly job (#121)', () => {
	it('sends a due daily schedule once, at the chosen local hour', async () => {
		const { user, organization, report } = await setup()
		const created = await createReportSchedule({
			organizationId: organization.id,
			userId: user.id,
			request,
			schedule: baseInput(report.id, [user.id]),
		})
		if (!created.ok) throw new Error('create failed')
		await backdate(created.data.id)
		const region = fakeRegion()

		// 07:00 Chicago: not yet.
		const early = await runDueReportSchedules({
			now: new Date('2027-01-05T13:00:00Z'),
			post: region.post,
		})
		expect(early.due).toBe(0)
		expect(region.calls).toHaveLength(0)

		// 08:00 Chicago: due, sent.
		const first = await runDueReportSchedules({ now: NOW, post: region.post })
		expect(first).toMatchObject({ due: 1, sent: 1 })
		expect(region.calls).toHaveLength(1)
		const sent = region.calls[0]!
		expect(sent.path).toBe('send')
		expect(sent.body).toMatchObject({
			orgId: organization.id,
			runKey: '2027-01-05',
			timeZone: 'America/Chicago',
			report: { kind: 'saved', title: 'Net sales' },
		})
		expect(sent.body.recipients[0].userId).toBe(user.id)
		expect(sent.body.recipients[0].unsubscribeUrl).toContain(
			'/resources/report-unsubscribe?token=',
		)
		// A later tick the same morning does not send again.
		const again = await runDueReportSchedules({
			now: new Date('2027-01-05T15:30:00Z'),
			post: region.post,
		})
		expect(again.due).toBe(0)
		expect(region.calls).toHaveLength(1)
		// The next day sends again.
		await runDueReportSchedules({
			now: new Date('2027-01-06T14:00:00Z'),
			post: region.post,
		})
		expect(region.calls).toHaveLength(2)
		expect(region.calls[1]!.body.runKey).toBe('2027-01-06')
		const [row] = await listReportSchedules(organization.id)
		expect(row!.lastSentAt).not.toBeNull()
		expect(row!.recipients[0]!.lastStatus).toBe('sent')
	})

	it('offers the daily summary on a schedule with the organization\'s modules', async () => {
		const { user, organization } = await setup()
		const created = await createReportSchedule({
			organizationId: organization.id,
			userId: user.id,
			request,
			schedule: baseInput(null, [user.id]),
		})
		if (!created.ok) throw new Error('create failed')
		await backdate(created.data.id)
		const region = fakeRegion()
		await runDueReportSchedules({ now: NOW, post: region.post })
		const body = region.calls[0]!.body
		expect(body.report.kind).toBe('daily_summary')
		expect(body.recipients[0].grants.subjects).toContain('sales')
		expect(body.recipients[0].grants.modules).toContain('marketing')
	})

	it('skips a member who lost access and one who left; the rest still receive it', async () => {
		const { user, organization, report } = await setup()
		const viewer = await createTestUser()
		await addOrganizationMember(viewer.id, organization.id, 'org_role_member')
		const leaver = await createTestUser()
		await addOrganizationMember(leaver.id, organization.id, 'org_role_admin')
		const created = await createReportSchedule({
			organizationId: organization.id,
			userId: user.id,
			request,
			schedule: baseInput(report.id, [user.id, viewer.id, leaver.id]),
		})
		if (!created.ok) throw new Error('create failed')
		await backdate(created.data.id)
		// The leaver is no longer a member at send time.
		await db
			.update(UserOrganization)
			.set({ active: false })
			.where(
				and(
					eq(UserOrganization.userId, leaver.id),
					eq(UserOrganization.organizationId, organization.id),
				),
			)
		const region = fakeRegion()
		await runDueReportSchedules({ now: NOW, post: region.post })
		expect(region.calls[0]!.body.recipients.map((r: { userId: string }) => r.userId)).toEqual([
			user.id,
		])
		const [row] = await listReportSchedules(organization.id)
		const status = Object.fromEntries(
			row!.recipients.map((r) => [r.userId, r.lastStatus]),
		)
		expect(status[viewer.id]).toBe('skipped_no_access')
		expect(status[leaver.id]).toBe('skipped_not_member')
		expect(status[user.id]).toBe('sent')
	})

	it('retries a failed send twice with backoff, then records the error', async () => {
		const { user, organization, report } = await setup()
		const created = await createReportSchedule({
			organizationId: organization.id,
			userId: user.id,
			request,
			schedule: baseInput(report.id, [user.id]),
		})
		if (!created.ok) throw new Error('create failed')
		await backdate(created.data.id)
		const region = fakeRegion(() => 'failed')
		const at = (iso: string) => new Date(iso)
		// Attempt 1 at 08:00; retry after 30 minutes (next hourly tick), then 2 hours.
		await runDueReportSchedules({ now: NOW, post: region.post })
		await runDueReportSchedules({ now: at('2027-01-05T14:20:00Z'), post: region.post })
		expect(region.calls).toHaveLength(1)
		await runDueReportSchedules({ now: at('2027-01-05T15:00:00Z'), post: region.post })
		expect(region.calls).toHaveLength(2)
		await runDueReportSchedules({ now: at('2027-01-05T15:30:00Z'), post: region.post })
		expect(region.calls).toHaveLength(2)
		await runDueReportSchedules({ now: at('2027-01-05T17:30:00Z'), post: region.post })
		expect(region.calls).toHaveLength(3)
		// No fourth attempt that day, and the error is recorded.
		await runDueReportSchedules({ now: at('2027-01-05T20:00:00Z'), post: region.post })
		expect(region.calls).toHaveLength(3)
		const [row] = await listReportSchedules(organization.id)
		expect(row).toMatchObject({ lastError: 'email_error', failureDays: 1 })
		expect(row!.pausedAt).toBeNull()
		// A retry uses the same instant: yesterday never moves.
		expect(new Set(region.calls.map((c) => c.body.now)).size).toBe(1)
	})

	it('pauses after three failed days and tells its creator', async () => {
		const { user, organization, report } = await setup()
		const created = await createReportSchedule({
			organizationId: organization.id,
			userId: user.id,
			request,
			schedule: baseInput(report.id, [user.id]),
		})
		if (!created.ok) throw new Error('create failed')
		await backdate(created.data.id)
		const region = fakeRegion(() => 'failed')
		const send = vi.fn().mockResolvedValue({ status: 'success', data: { id: 'x' } })
		for (const day of ['05', '06', '07']) {
			for (const hour of ['14:00', '15:00', '17:30']) {
				await runDueReportSchedules({
					now: new Date(`2027-01-${day}T${hour}:00Z`),
					post: region.post,
					sendEmailImpl: send as never,
				})
			}
		}
		const [row] = await listReportSchedules(organization.id)
		expect(row!.failureDays).toBe(3)
		expect(row!.pausedAt).not.toBeNull()
		expect(row!.pausedReason).toBe('failures')
		expect(send).toHaveBeenCalledTimes(1)
		expect(send.mock.calls[0]![0].to).toBeTruthy()
		const notes = await db
			.select()
			.from(Notification)
			.where(eq(Notification.organizationId, organization.id))
		expect(notes.map((n) => n.type)).toContain('reports.schedule_paused')
		// A paused schedule is never sent.
		const before = region.calls.length
		await runDueReportSchedules({
			now: new Date('2027-01-08T14:00:00Z'),
			post: region.post,
		})
		expect(region.calls).toHaveLength(before)
	})

	it('does not send an unsubscribed recipient, and unsubscribing works from the emailed link', async () => {
		const { user, organization, report } = await setup()
		const created = await createReportSchedule({
			organizationId: organization.id,
			userId: user.id,
			request,
			schedule: baseInput(report.id, [user.id]),
		})
		if (!created.ok) throw new Error('create failed')
		await backdate(created.data.id)
		const link = reportUnsubscribeUrl({
			kind: 'schedule',
			scheduleId: created.data.id,
			userId: user.id,
		})
		const token = new URL(link).searchParams.get('token')!
		expect(await applyReportUnsubscribe(`${token}x`)).toEqual({ ok: false })
		expect(await applyReportUnsubscribe(token)).toEqual({ ok: true, kind: 'schedule' })
		const [recipient] = await db
			.select()
			.from(ReportScheduleRecipient)
			.where(eq(ReportScheduleRecipient.scheduleId, created.data.id))
		expect(recipient!.unsubscribedAt).not.toBeNull()
		const region = fakeRegion()
		await runDueReportSchedules({ now: NOW, post: region.post })
		expect(region.calls).toHaveLength(0)
	})

	it('leaves schedules alone when the flag is off', async () => {
		const { user, organization, report } = await setup()
		const created = await createReportSchedule({
			organizationId: organization.id,
			userId: user.id,
			request,
			schedule: baseInput(report.id, [user.id]),
		})
		if (!created.ok) throw new Error('create failed')
		await backdate(created.data.id)
		await db.delete(ConfigFlag).where(eq(ConfigFlag.id, flagId!))
		flagId = null
		const region = fakeRegion()
		await runDueReportSchedules({ now: NOW, post: region.post })
		expect(region.calls).toHaveLength(0)
	})
})

beforeEach(() => {
	flagId = null
})
