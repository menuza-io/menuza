import { requireUserId } from '@repo/auth'
import { data } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { setMonthlyResultsEmail } from '#app/utils/reports/report-unsubscribe.server.ts'
import { setMemberReportEmail } from '#app/utils/reports/schedules.server.ts'
import { type Route } from './+types/email-preferences.ts'

/**
 * A member's own report email switches (Settings, Notifications, #121 and
 * #221): one scheduled report's email, or the monthly results email. A member
 * can only change their own row; nothing here reads a report.
 */
export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	const body = (await request.json().catch(() => null)) as {
		intent?: unknown
		scheduleId?: unknown
		subscribed?: unknown
	} | null
	if (!body || typeof body.subscribed !== 'boolean') {
		return data({ ok: false }, { status: 400 })
	}
	if (body.intent === 'monthly') {
		await setMonthlyResultsEmail({
			userId,
			organizationId: organization.id,
			email: body.subscribed,
		})
		return data({ ok: true })
	}
	if (body.intent === 'schedule' && typeof body.scheduleId === 'string') {
		const done = await setMemberReportEmail({
			userId,
			organizationId: organization.id,
			scheduleId: body.scheduleId,
			subscribed: body.subscribed,
		})
		return done ? data({ ok: true }) : data({ ok: false }, { status: 404 })
	}
	return data({ ok: false }, { status: 400 })
}
