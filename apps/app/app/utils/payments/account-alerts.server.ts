import {
	and,
	db,
	eq,
	isNotNull,
	Notification,
	Organization,
	OrganizationLocation,
	PaymentAccountStatus,
} from '@repo/database'
import { PaymentAccountAlertEmail, sendEmail } from '@repo/email'
import { createElement } from 'react'
import { resolveDomainAlertRecipients } from '#app/utils/domains/notify.server.ts'
import { readLiveEnv } from '#app/utils/env.server.ts'
import {
	duePaymentAccountReminderBucket,
	evaluatePaymentAccountState,
	shouldSendReminderBucket,
	type PaymentAccountHealthState,
} from './account-status.ts'

export const PAYMENT_ACCOUNT_NOTIFICATION_TYPES = {
	action_needed: 'payments.account_action_needed',
	payouts_paused: 'payments.account_payouts_paused',
	cannot_take_payments: 'payments.account_charges_disabled',
	recovered: 'payments.account_recovered',
} as const

function formatDeadlineDate(deadline: Date | null): string | null {
	if (!deadline) return null
	return new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(deadline)
}

async function loadOrgAndLocations(organizationId: string) {
	const [org] = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!org) return null
	const locations = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
	return { org, locations }
}

async function sendPaymentAccountAlertToRecipients(input: {
	organizationId: string
	provider: 'connect' | 'checkout'
	state:
		'action_needed' | 'payouts_paused' | 'cannot_take_payments' | 'recovered'
	dedupeKey: string
	requirements: string[]
	deadline: Date | null
	isReminder?: boolean
}): Promise<number> {
	const orgInfo = await loadOrgAndLocations(input.organizationId)
	if (!orgInfo) return 0
	const { org, locations } = orgInfo
	const baseUrl = readLiveEnv('BASE_URL').replace(/\/$/u, '')
	const actionUrl = `${baseUrl}/${org.slug}/settings/shop`
	const deadlineLabel = formatDeadlineDate(input.deadline)
	const locationNames = locations.map((l) => l.name)

	const subject =
		input.state === 'recovered'
			? `All set: payment account active for ${org.name}`
			: input.state === 'cannot_take_payments'
				? `Urgent: ${org.name} cannot take online payments`
				: input.state === 'payouts_paused'
					? `Action required: payouts paused for ${org.name}`
					: input.isReminder && deadlineLabel
						? `Reminder: payment account info due by ${deadlineLabel} (${org.name})`
						: `Action needed on your payment account (${org.name})`

	const recipients = await resolveDomainAlertRecipients(input.organizationId)
	let sent = 0
	for (const recipient of recipients) {
		const inserted = await db
			.insert(Notification)
			.values({
				userId: recipient.userId,
				organizationId: input.organizationId,
				type: PAYMENT_ACCOUNT_NOTIFICATION_TYPES[input.state],
				entityId: input.dedupeKey,
				payload: JSON.stringify({
					orgSlug: org.slug,
					provider: input.provider,
					state: input.state,
					deadline: input.deadline?.toISOString() ?? null,
					requirements: input.requirements,
				}),
			})
			.onConflictDoNothing()
			.returning({ id: Notification.id })
		if (inserted.length === 0) continue
		sent += 1
		try {
			await sendEmail({
				to: recipient.email,
				subject,
				react: createElement(PaymentAccountAlertEmail, {
					organizationName: org.name,
					locationNames,
					state: input.state,
					requirements: input.requirements,
					deadlineLabel,
					actionUrl,
					isReminder: input.isReminder ?? false,
				}),
			})
		} catch (error) {
			console.error('Payment account alert email failed:', error)
		}
	}
	return sent
}

/**
 * Persist the latest payment account status from Stripe Connect or Checkout.com
 * and send at most ONE email + in-app notification per state transition (#269).
 * Sends one "All set" recovery email when returning from a problem state to active.
 */
export async function syncPaymentAccountStatusAndNotify(input: {
	organizationId: string
	provider: 'connect' | 'checkout'
	providerAccountId: string | null
	chargesEnabled: boolean
	payoutsEnabled: boolean
	requirementsDue: string[]
	deadline: Date | null
	now?: Date
}): Promise<{
	state: PaymentAccountHealthState
	notified: number
	recovered: boolean
}> {
	const now = input.now ?? new Date()
	const evaluated = evaluatePaymentAccountState({
		chargesEnabled: input.chargesEnabled,
		payoutsEnabled: input.payoutsEnabled,
		requirementsDue: input.requirementsDue,
		deadline: input.deadline,
	})

	const [existing] = await db
		.select()
		.from(PaymentAccountStatus)
		.where(
			and(
				eq(PaymentAccountStatus.organizationId, input.organizationId),
				eq(PaymentAccountStatus.provider, input.provider),
			),
		)
		.limit(1)

	const previousState = existing?.lastNotifiedState ?? null
	const wasUnhealthy = previousState !== null && previousState !== 'active'
	const stateChanged = previousState !== evaluated.stateKey

	let notified = 0
	let recovered = false
	let nextLastNotifiedState = previousState
	let nextReminderBucket = existing?.lastReminderBucket ?? null
	let nextLastNotifiedAt = existing?.lastNotifiedAt ?? null

	if (evaluated.state === 'active') {
		nextLastNotifiedState = 'active'
		nextReminderBucket = null
		if (wasUnhealthy) {
			recovered = true
			notified = await sendPaymentAccountAlertToRecipients({
				organizationId: input.organizationId,
				provider: input.provider,
				state: 'recovered',
				dedupeKey: `payacct:${input.provider}:recovered:${now.toISOString().slice(0, 10)}:${previousState}`,
				requirements: [],
				deadline: null,
			})
			nextLastNotifiedAt = now
		}
	} else if (stateChanged) {
		notified = await sendPaymentAccountAlertToRecipients({
			organizationId: input.organizationId,
			provider: input.provider,
			state: evaluated.state,
			dedupeKey: `payacct:${input.provider}:${evaluated.stateKey}`,
			requirements: evaluated.requirementDescriptions,
			deadline: evaluated.deadline,
		})
		nextLastNotifiedState = evaluated.stateKey
		nextLastNotifiedAt = now
		// If deadline is already within a reminder bucket, mark that bucket so
		// the daily job doesn't immediately double-email on the same day.
		const currentBucket = duePaymentAccountReminderBucket(
			evaluated.deadline,
			now.getTime(),
		)
		nextReminderBucket = currentBucket
	}

	const requirementsJson = JSON.stringify(
		[...new Set(input.requirementsDue.filter(Boolean))].sort(),
	)

	if (existing) {
		await db
			.update(PaymentAccountStatus)
			.set({
				providerAccountId: input.providerAccountId,
				chargesEnabled: input.chargesEnabled,
				payoutsEnabled: input.payoutsEnabled,
				requirementsDue: requirementsJson,
				deadline: input.deadline,
				lastNotifiedState: nextLastNotifiedState,
				lastReminderBucket: nextReminderBucket,
				lastNotifiedAt: nextLastNotifiedAt,
				updatedAt: now,
			})
			.where(eq(PaymentAccountStatus.id, existing.id))
	} else {
		await db.insert(PaymentAccountStatus).values({
			organizationId: input.organizationId,
			provider: input.provider,
			providerAccountId: input.providerAccountId,
			chargesEnabled: input.chargesEnabled,
			payoutsEnabled: input.payoutsEnabled,
			requirementsDue: requirementsJson,
			deadline: input.deadline,
			lastNotifiedState: nextLastNotifiedState,
			lastReminderBucket: nextReminderBucket,
			lastNotifiedAt: nextLastNotifiedAt,
			createdAt: now,
			updatedAt: now,
		})
	}

	return { state: evaluated.state, notified, recovered }
}

/**
 * Daily cron job (#269): sends 7, 3, and 1 day deadline reminders for any
 * payment account with an upcoming deadline, stopping automatically once resolved.
 */
export async function runDailyPaymentAccountDeadlineChecks(
	nowMs = Date.now(),
): Promise<{ checked: number; reminded: number }> {
	const rows = await db
		.select()
		.from(PaymentAccountStatus)
		.where(isNotNull(PaymentAccountStatus.deadline))

	let reminded = 0
	for (const row of rows) {
		let requirementsDue: string[] = []
		try {
			const parsed = JSON.parse(row.requirementsDue)
			if (Array.isArray(parsed)) {
				requirementsDue = parsed.filter(
					(x): x is string => typeof x === 'string',
				)
			}
		} catch {
			requirementsDue = []
		}

		const evaluated = evaluatePaymentAccountState({
			chargesEnabled: row.chargesEnabled,
			payoutsEnabled: row.payoutsEnabled,
			requirementsDue,
			deadline: row.deadline,
		})
		if (evaluated.state === 'active') continue

		const bucket = duePaymentAccountReminderBucket(row.deadline, nowMs)
		if (!shouldSendReminderBucket(bucket, row.lastReminderBucket)) continue
		if (bucket === null) continue

		const sent = await sendPaymentAccountAlertToRecipients({
			organizationId: row.organizationId,
			provider: row.provider === 'checkout' ? 'checkout' : 'connect',
			state: evaluated.state,
			dedupeKey: `payacct:${row.provider}:reminder:${bucket}:${evaluated.stateKey}`,
			requirements: evaluated.requirementDescriptions,
			deadline: row.deadline,
			isReminder: true,
		})
		reminded += sent

		await db
			.update(PaymentAccountStatus)
			.set({
				lastReminderBucket: bucket,
				lastNotifiedAt: new Date(nowMs),
				updatedAt: new Date(nowMs),
			})
			.where(eq(PaymentAccountStatus.id, row.id))
	}

	return { checked: rows.length, reminded }
}
