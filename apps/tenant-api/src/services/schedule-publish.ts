import { forEachWithBudget } from '../lib/concurrency.ts'
import {
	type StaffingAuth,
	staffingSwitchEnabled,
} from '../lib/staffing-auth.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import {
	buildScheduleEmail,
	type ScheduleEmailLocale,
} from './schedule-email.ts'
import { type ServiceResult } from './staffing-roster.ts'
import {
	commitPublish,
	loadRecipients,
	positionNames,
	recordNotifications,
} from './staffing-schedule.ts'

export type NotNotifiedReason =
	'no_email' | 'email_disabled' | 'send_failed' | 'not_sent'

const SEND_CONCURRENCY = 4
/** Publish answers within the request; unsent people are reported, not retried. */
const SEND_BUDGET_MS = 20_000

export async function publishSchedule(
	orgId: string,
	auth: StaffingAuth,
	input: {
		locationId: string
		weekStart: string
		locationName: string
		emailLocale: ScheduleEmailLocale
	},
): Promise<
	ServiceResult<{
		publicationId: string
		changedCount: number
		shiftCount: number
		notified: number
		notNotified: { staffId: string; name: string; reason: NotNotifiedReason }[]
	}>
> {
	const committed = await commitPublish(orgId, auth, input)
	if (!committed.ok) return committed
	const { publication, changes } = committed.data
	const recipients = new Map(
		(
			await loadRecipients(
				orgId,
				changes.map((change) => change.staffId),
			)
		).map((row) => [row.id, row]),
	)
	const emailEnabled = staffingSwitchEnabled('STAFFING_EMAIL_ENABLED')
	const positions = await positionNames(orgId)
	const notNotified: {
		staffId: string
		name: string
		reason: NotNotifiedReason
	}[] = []
	const outbox: {
		staffId: string
		name: string
		email: string
		change: (typeof changes)[number]
	}[] = []
	for (const change of changes) {
		const person = recipients.get(change.staffId)
		// Terminated people are not told about a schedule they are no longer on.
		if (!person || person.status !== 'active') continue
		const name = [person.firstName, person.lastName].filter(Boolean).join(' ')
		if (!person.email) {
			notNotified.push({ staffId: person.id, name, reason: 'no_email' })
		} else if (!emailEnabled) {
			notNotified.push({ staffId: person.id, name, reason: 'email_disabled' })
		} else {
			outbox.push({ staffId: person.id, name, email: person.email, change })
		}
	}

	let notified = 0
	const attempted = new Set<string>()
	await forEachWithBudget(
		outbox,
		{ concurrency: SEND_CONCURRENCY, deadline: Date.now() + SEND_BUDGET_MS },
		async (item) => {
			attempted.add(item.staffId)
			const person = recipients.get(item.staffId)!
			const message = buildScheduleEmail({
				locale: input.emailLocale,
				firstName: person.firstName,
				locationName: input.locationName,
				weekStart: input.weekStart,
				current: item.change.current,
				removed: item.change.removed,
				positions,
			})
			try {
				const result = await sendTenantEmail({
					to: item.email,
					toName: item.name,
					subject: message.subject,
					html: message.html,
					text: message.text,
				})
				if (result.status === 'error') throw new Error('send_failed')
				notified++
			} catch {
				notNotified.push({
					staffId: item.staffId,
					name: item.name,
					reason: 'send_failed',
				})
			}
		},
	)
	for (const item of outbox) {
		if (!attempted.has(item.staffId)) {
			notNotified.push({
				staffId: item.staffId,
				name: item.name,
				reason: 'not_sent',
			})
		}
	}
	await recordNotifications(orgId, publication.id, {
		notified,
		notNotified: notNotified.length,
	})
	return {
		ok: true,
		data: {
			publicationId: publication.id,
			changedCount: publication.changedCount,
			shiftCount: publication.shiftCount,
			notified,
			notNotified: notNotified.sort((a, b) => a.name.localeCompare(b.name)),
		},
	}
}
