import {
	and,
	db,
	eq,
	MonthlyResultsDelivery,
	NotificationPreference,
	ReportScheduleRecipient,
} from '@repo/database'
import {
	signReportUnsubscribeToken,
	verifyReportUnsubscribeToken,
	type ReportUnsubscribeTarget,
} from '@repo/reports/schedule'
import { ENV } from 'varlock/env'
import { readLiveEnv } from '#app/utils/env.server.ts'

/** The notification workflow key of the monthly results email (#221). */
export const MONTHLY_RESULTS_WORKFLOW = 'reports.monthly_results'

function secret(): string {
	return String(ENV.SESSION_SECRET ?? '')
}

/** The signed one-click link in a report email; it needs no login. */
export function reportUnsubscribeUrl(target: ReportUnsubscribeTarget): string {
	const base = readLiveEnv('BASE_URL').replace(/\/$/u, '')
	const token = signReportUnsubscribeToken(target, secret())
	return `${base}/resources/report-unsubscribe?token=${encodeURIComponent(token)}`
}

export type UnsubscribeResult =
	{ ok: true; kind: ReportUnsubscribeTarget['kind'] } | { ok: false }

/**
 * Switches one recipient's report email off from a signed token (the link in
 * the email, or a mail client's one-click POST). Idempotent. A forged or
 * edited token changes nothing.
 */
export async function applyReportUnsubscribe(
	token: string,
	now = new Date(),
): Promise<UnsubscribeResult> {
	const target = verifyReportUnsubscribeToken(token, secret())
	if (!target) return { ok: false }
	if (target.kind === 'schedule') {
		await db
			.update(ReportScheduleRecipient)
			.set({ unsubscribedAt: now })
			.where(
				and(
					eq(ReportScheduleRecipient.scheduleId, target.scheduleId),
					eq(ReportScheduleRecipient.userId, target.userId),
				),
			)
		return { ok: true, kind: 'schedule' }
	}
	await setMonthlyResultsEmail({
		userId: target.userId,
		organizationId: target.organizationId,
		email: false,
	})
	return { ok: true, kind: 'monthly' }
}

/** A member's switch for the monthly results email: on unless they turned it off. */
export async function setMonthlyResultsEmail(input: {
	userId: string
	organizationId: string
	email: boolean
}) {
	await db
		.insert(NotificationPreference)
		.values({
			userId: input.userId,
			organizationId: input.organizationId,
			workflow: MONTHLY_RESULTS_WORKFLOW,
			email: input.email,
		})
		.onConflictDoUpdate({
			target: [
				NotificationPreference.userId,
				NotificationPreference.organizationId,
				NotificationPreference.workflow,
			],
			set: { email: input.email, updatedAt: new Date() },
		})
}

export async function monthlyResultsEmailEnabled(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ email: NotificationPreference.email })
		.from(NotificationPreference)
		.where(
			and(
				eq(NotificationPreference.userId, userId),
				eq(NotificationPreference.organizationId, organizationId),
				eq(NotificationPreference.workflow, MONTHLY_RESULTS_WORKFLOW),
			),
		)
		.limit(1)
	return row ? row.email : true
}

export { MonthlyResultsDelivery }
