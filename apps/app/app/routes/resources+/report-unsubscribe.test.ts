import { db, eq, ReportSchedule, ReportScheduleRecipient, SavedReport } from '@repo/database'
import { createReportDefinition } from '@repo/reports'
import { describe, expect, it } from 'vitest'
import { reportUnsubscribeUrl } from '#app/utils/reports/report-unsubscribe.server.ts'
import { monthlyResultsEmailEnabled } from '#app/utils/reports/report-unsubscribe.server.ts'
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
					visualization: { chartStyle: 'single_number', measure: 'sum', valueField: 'netSales' },
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

describe('one-click unsubscribe from a report email (#121, #221)', () => {
	it('works without a login: GET on the link switches the schedule off for that member only', async () => {
		const { user, schedule } = await seedSchedule()
		const url = reportUnsubscribeUrl({
			kind: 'schedule',
			scheduleId: schedule.id,
			userId: user.id,
		})
		// No cookie, no session: the request is a plain GET.
		const response = await loader({
			request: new Request(url),
			params: {},
			context: {},
		} as never)
		expect(response.status).toBe(200)
		expect(await response.text()).toContain('You are unsubscribed')
		const [row] = await db
			.select()
			.from(ReportScheduleRecipient)
			.where(eq(ReportScheduleRecipient.scheduleId, schedule.id))
		expect(row!.unsubscribedAt).not.toBeNull()
	})

	it('accepts the mail client\'s one-click POST', async () => {
		const { user, schedule } = await seedSchedule()
		const url = reportUnsubscribeUrl({
			kind: 'schedule',
			scheduleId: schedule.id,
			userId: user.id,
		})
		const response = await action({
			request: new Request(url, {
				method: 'POST',
				body: 'List-Unsubscribe=One-Click',
			}),
			params: {},
			context: {},
		} as never)
		expect(response.status).toBe(200)
		const [row] = await db
			.select()
			.from(ReportScheduleRecipient)
			.where(eq(ReportScheduleRecipient.scheduleId, schedule.id))
		expect(row!.unsubscribedAt).not.toBeNull()
	})

	it('refuses a forged, edited or missing token and changes nothing', async () => {
		const { user, schedule } = await seedSchedule()
		const url = reportUnsubscribeUrl({
			kind: 'schedule',
			scheduleId: schedule.id,
			userId: user.id,
		})
		const token = tokenOf(url)
		for (const bad of [`${token}x`, token.replace(/.$/, 'A'), 'garbage', '']) {
			const response = await loader({
				request: new Request(
					`http://localhost:3000/resources/report-unsubscribe?token=${encodeURIComponent(bad)}`,
				),
				params: {},
				context: {},
			} as never)
			expect(response.status).toBe(400)
		}
		const [row] = await db
			.select()
			.from(ReportScheduleRecipient)
			.where(eq(ReportScheduleRecipient.scheduleId, schedule.id))
		expect(row!.unsubscribedAt).toBeNull()
	})

	it('switches the monthly results email off from its own link', async () => {
		const { user, organization } = await seedSchedule()
		expect(await monthlyResultsEmailEnabled(user.id, organization.id)).toBe(true)
		const url = reportUnsubscribeUrl({
			kind: 'monthly',
			organizationId: organization.id,
			userId: user.id,
		})
		const response = await loader({
			request: new Request(url),
			params: {},
			context: {},
		} as never)
		expect(response.status).toBe(200)
		expect(await monthlyResultsEmailEnabled(user.id, organization.id)).toBe(false)
	})
})
