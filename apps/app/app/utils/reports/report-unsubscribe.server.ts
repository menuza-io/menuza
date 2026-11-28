import { SETUP_REMINDER_WORKFLOW } from '@repo/common/setup-reminders'
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
} from '@repo/reports/unsubscribe-token'
import { ENV } from 'varlock/env'
import { readLiveEnv } from '#app/utils/env.server.ts'

/** The notification workflow key of the monthly results email (#221). */
export const MONTHLY_RESULTS_WORKFLOW = 'reports.monthly_results'

/**
 * The key of the unsubscribe links: `REPORT_UNSUBSCRIBE_SECRET`, else the
 * session secret (the token's own purpose string keeps the derived key apart).
 * Links in sent emails never expire, so a deployment sets the dedicated one
 * and a session secret rotation then leaves them working.
 */
function secret(): string {
	const dedicated = readLiveEnv('REPORT_UNSUBSCRIBE_SECRET')
	return dedicated.length >= 16 ? dedicated : String(ENV.SESSION_SECRET ?? '')
}

/** The signed one-click link in a report email; it needs no login. */
export function reportUnsubscribeUrl(target: ReportUnsubscribeTarget): string {
	const base = readLiveEnv('BASE_URL').replace(/\/$/u, '')
	const token = signReportUnsubscribeToken(target, secret())
	return `${base}/resources/report-unsubscribe?token=${encodeURIComponent(token)}`
}

/** Whether a token is one this app signed (nothing is changed). */
export function isValidReportUnsubscribeToken(token: string): boolean {
	return verifyReportUnsubscribeToken(token, secret()) !== null
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
	if (target.kind === 'setup') {
		await setSetupReminderEmail({
			userId: target.userId,
			organizationId: target.organizationId,
			email: false,
		})
		return { ok: true, kind: 'setup' }
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

/** An owner's switch for the setup reminder emails (#271): on unless they turned it off. */
export async function setSetupReminderEmail(input: {
	userId: string
	organizationId: string
	email: boolean
}) {
	await db
		.insert(NotificationPreference)
		.values({
			userId: input.userId,
			organizationId: input.organizationId,
			workflow: SETUP_REMINDER_WORKFLOW,
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

export async function setupReminderEmailEnabled(
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
				eq(NotificationPreference.workflow, SETUP_REMINDER_WORKFLOW),
			),
		)
		.limit(1)
	return row ? row.email : true
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
