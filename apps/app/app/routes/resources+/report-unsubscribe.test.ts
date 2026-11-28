import { SETUP_REMINDER_WORKFLOW } from '@repo/common/setup-reminders'
import {
	db,
	eq,
	NotificationPreference,
	ReportSchedule,
	ReportScheduleRecipient,
	SavedReport,
} from '@repo/database'
import { createReportDefinition } from '@repo/reports'
import { describe, expect, it } from 'vitest'
import {
	reportUnsubscribeUrl,
	monthlyResultsEmailEnabled,
} from '#app/utils/reports/report-unsubscribe.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { action, loader } from './report-unsubscribe.ts'

async function seedSchedule() {
	const { user, organization } = await setupTestOrgWithUser('admin')
	const [report] = await db
		.insert(SavedReport)
		.values({
			scope: 'organization',
			organizationId: organization.id,
			createdById: user.id,
			title: 'Net sales',
			notes: '',
			definition: JSON.stringify(
				createReportDefinition({
					subject: 'sales',
					timeframe: { field: 'occurredAt', preset: 'yesterday' },
					visualization: {
						chartStyle: 'single_number',
						measure: 'sum',
						valueField: 'netSales',
					},
					settings: { title: 'Net sales', timezone: 'user' },
				}),
			),
		})
		.returning()
	const [schedule] = await db
		.insert(ReportSchedule)
		.values({
			organizationId: organization.id,
			savedReportId: report!.id,
			cadence: 'daily',
			hour: 8,
			timeZone: 'UTC',
			createdById: user.id,
		})
		.returning()
	await db
		.insert(ReportScheduleRecipient)
		.values({ scheduleId: schedule!.id, userId: user.id })
	return { user, organization, schedule: schedule! }
}

const tokenOf = (url: string) => new URL(url).searchParams.get('token')!

const post = (url: string, init: RequestInit = {}) =>
	action({
		request: new Request(url, { method: 'POST', ...init }),
		params: {},
		context: {},
	} as never)
const get = (url: string) =>
	loader({ request: new Request(url), params: {}, context: {} } as never)
const unsubscribedAt = async (scheduleId: string) =>
	(
		await db
			.select()
			.from(ReportScheduleRecipient)
			.where(eq(ReportScheduleRecipient.scheduleId, scheduleId))
	)[0]!.unsubscribedAt

describe('unsubscribe from a report email (#121, #221)', () => {
	it('GET on the emailed link only shows a confirm button: scanners and previewers change nothing', async () => {
		const { user, schedule } = await seedSchedule()
		const url = reportUnsubscribeUrl({
			kind: 'schedule',
			scheduleId: schedule.id,
			userId: user.id,
		})
		// No cookie, no session: the request is a plain GET.
		const response = await get(url)
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('<form method="post"')
		expect(html).toContain('/resources/report-unsubscribe?token=')
		expect(html).not.toContain('You are unsubscribed')
		expect(response.headers.get('referrer-policy')).toBe('no-referrer')
		expect(await unsubscribedAt(schedule.id)).toBeNull()
	})

	it('POST (the button, or the mail client one-click) switches the schedule off for that member only, and repeating it is harmless', async () => {
		const { user, schedule } = await seedSchedule()
		const url = reportUnsubscribeUrl({
			kind: 'schedule',
			scheduleId: schedule.id,
			userId: user.id,
		})
		for (let i = 0; i < 2; i += 1) {
			const response = await post(url, { body: 'List-Unsubscribe=One-Click' })
			expect(response.status).toBe(200)
			expect(await response.text()).toContain('You are unsubscribed')
		}
		expect(await unsubscribedAt(schedule.id)).not.toBeNull()
	})

	it('refuses a forged, edited or missing token, on GET and POST, and changes nothing', async () => {
		const { user, schedule } = await seedSchedule()
		const url = reportUnsubscribeUrl({
			kind: 'schedule',
			scheduleId: schedule.id,
			userId: user.id,
		})
		const token = tokenOf(url)
		for (const bad of [`${token}x`, token.replace(/.$/, 'A'), 'garbage', '']) {
			const target = `http://localhost:3000/resources/report-unsubscribe?token=${encodeURIComponent(bad)}`
			expect((await get(target)).status).toBe(400)
			expect((await post(target)).status).toBe(400)
		}
		const none = await post(
			'http://localhost:3000/resources/report-unsubscribe',
		)
		expect(none.status).toBe(400)
		expect(await unsubscribedAt(schedule.id)).toBeNull()
	})

	it('refuses other methods', async () => {
		const { user, schedule } = await seedSchedule()
		const url = reportUnsubscribeUrl({
			kind: 'schedule',
			scheduleId: schedule.id,
			userId: user.id,
		})
		const response = await action({
			request: new Request(url, { method: 'DELETE' }),
			params: {},
			context: {},
		} as never)
		expect(response.status).toBe(405)
	})

	it('switches the monthly results email off from its own link, by POST only', async () => {
		const { user, organization } = await seedSchedule()
		expect(await monthlyResultsEmailEnabled(user.id, organization.id)).toBe(
			true,
		)
		const url = reportUnsubscribeUrl({
			kind: 'monthly',
			organizationId: organization.id,
			userId: user.id,
		})
		expect((await get(url)).status).toBe(200)
		expect(await monthlyResultsEmailEnabled(user.id, organization.id)).toBe(
			true,
		)
		expect((await post(url)).status).toBe(200)
		expect(await monthlyResultsEmailEnabled(user.id, organization.id)).toBe(
			false,
		)
	})
})

describe('unsubscribe from the setup reminder emails (#271)', () => {
	it('switches the reminders off for that owner and organization only', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const other = await setupTestOrgWithUser('admin')
		const url = reportUnsubscribeUrl({
			kind: 'setup',
			organizationId: organization.id,
			userId: user.id,
		})
		const response = await post(url, { body: 'List-Unsubscribe=One-Click' })
		expect(response.status).toBe(200)
		expect(await response.text()).toContain('You are unsubscribed')
		const preferences = await db
			.select()
			.from(NotificationPreference)
			.where(eq(NotificationPreference.userId, user.id))
		expect(preferences).toHaveLength(1)
		expect(preferences[0]).toMatchObject({
			organizationId: organization.id,
			workflow: SETUP_REMINDER_WORKFLOW,
			email: false,
		})
		expect(
			await db
				.select()
				.from(NotificationPreference)
				.where(eq(NotificationPreference.userId, other.user.id)),
		).toEqual([])
	})
})
