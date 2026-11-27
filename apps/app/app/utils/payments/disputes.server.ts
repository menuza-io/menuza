import {
	and,
	db,
	desc,
	eq,
	gte,
	isNull,
	lte,
	Notification,
	Organization,
	PaymentDispute,
} from '@repo/database'
import { sendEmail, StaffingAlertEmail } from '@repo/email'
import {
	acceptProviderDispute,
	submitProviderDisputeEvidence,
	type ControlPlaneDisputeStatus,
	type DisputeEvidencePayload,
} from '@repo/payments'
import { createElement } from 'react'
import { resolveDomainAlertRecipients } from '#app/utils/domains/notify.server.ts'
import { readLiveEnv } from '#app/utils/env.server.ts'
import { getPaymentsMockStatus } from '#app/utils/payments-mock/gate.server.ts'
import { stripe } from '#app/utils/payments.server.ts'

export const DISPUTE_REMINDER_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

async function notifyManagersAboutDispute(input: {
	organizationId: string
	disputeId: string
	orderRef: string
	amountMinor: number
	currency: string
	dueAt: Date | null
	kind: 'opened' | 'reminder'
}): Promise<number> {
	const [org] = await db
		.select({ name: Organization.name, slug: Organization.slug })
		.from(Organization)
		.where(eq(Organization.id, input.organizationId))
		.limit(1)
	if (!org) return 0

	const baseUrl = readLiveEnv('BASE_URL').replace(/\/$/u, '')
	const actionUrl = `${baseUrl}/${org.slug}/orders/disputes/${encodeURIComponent(input.disputeId)}`
	const formattedAmount = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: input.currency || 'USD',
	}).format(input.amountMinor / 100)
	const dueLabel = input.dueAt
		? new Intl.DateTimeFormat('en-US', {
				month: 'short',
				day: 'numeric',
				year: 'numeric',
				timeZone: 'UTC',
			}).format(input.dueAt)
		: null

	const isReminder = input.kind === 'reminder'
	const subject = isReminder
		? `Reminder: answer payment dispute (${formattedAmount}) by ${dueLabel ?? 'deadline'}`
		: `New payment dispute (${formattedAmount}) for ${org.name}`
	const headline = isReminder
		? `Dispute response due soon (${formattedAmount})`
		: `A guest disputed a ${formattedAmount} payment`
	const detail = dueLabel
		? `Submit evidence or accept the dispute for order ${input.orderRef} before ${dueLabel}.`
		: `Review and respond to the dispute for order ${input.orderRef}.`

	const recipients = await resolveDomainAlertRecipients(input.organizationId)
	let sent = 0
	for (const recipient of recipients) {
		const inserted = await db
			.insert(Notification)
			.values({
				userId: recipient.userId,
				organizationId: input.organizationId,
				type: isReminder
					? 'payments.dispute_deadline_reminder'
					: 'payments.dispute_opened',
				entityId: `dispute:${input.disputeId}:${input.kind}`,
				payload: JSON.stringify({
					orgSlug: org.slug,
					disputeId: input.disputeId,
					orderRef: input.orderRef,
					amountMinor: input.amountMinor,
					currency: input.currency,
					dueAt: input.dueAt?.toISOString() ?? null,
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
				react: createElement(StaffingAlertEmail, {
					eyebrow: 'Payment dispute',
					headline,
					detail,
					actionLabel: 'Review dispute',
					actionUrl,
					settingsNote: '',
				}),
			})
		} catch (error) {
			console.error('Payment dispute alert email failed:', error)
		}
	}
	return sent
}

/**
 * Idempotently upsert a dispute from a Stripe or Checkout.com webhook (#187).
 * Deduplicated on `(provider, providerDisputeId)` so duplicate webhooks never
 * create duplicate rows or send duplicate notifications.
 */
export async function upsertPaymentDisputeAndNotify(input: {
	organizationId: string
	provider: 'connect' | 'checkout'
	providerDisputeId: string
	providerPaymentId: string | null
	orderKind: 'restaurant_order' | 'reservation' | 'qr_tab' | 'gift_card'
	orderRef: string
	amountMinor: number
	feeMinor?: number
	currency: string
	reason: string
	status: ControlPlaneDisputeStatus
	dueAt: Date | null
	alreadyRefunded?: boolean
	now?: Date
}): Promise<{ id: string; created: boolean; notified: number }> {
	const now = input.now ?? new Date()
	const isClosed =
		input.status === 'won' ||
		input.status === 'lost' ||
		input.status === 'accepted'

	const [existing] = await db
		.select()
		.from(PaymentDispute)
		.where(
			and(
				eq(PaymentDispute.provider, input.provider),
				eq(PaymentDispute.providerDisputeId, input.providerDisputeId),
			),
		)
		.limit(1)

	if (existing) {
		const nextFee = Math.max(existing.feeMinor, input.feeMinor ?? 0)
		await db
			.update(PaymentDispute)
			.set({
				status: input.status,
				feeMinor: nextFee,
				dueAt: input.dueAt ?? existing.dueAt,
				closedAt: isClosed ? (existing.closedAt ?? now) : existing.closedAt,
				alreadyRefunded:
					existing.alreadyRefunded || Boolean(input.alreadyRefunded),
				updatedAt: now,
			})
			.where(eq(PaymentDispute.id, existing.id))
		return { id: existing.id, created: false, notified: 0 }
	}

	const [inserted] = await db
		.insert(PaymentDispute)
		.values({
			organizationId: input.organizationId,
			provider: input.provider,
			providerDisputeId: input.providerDisputeId,
			providerPaymentId: input.providerPaymentId,
			orderKind: input.orderKind,
			orderRef: input.orderRef,
			amountMinor: input.amountMinor,
			feeMinor: input.feeMinor ?? 0,
			currency: input.currency.toUpperCase(),
			reason: input.reason,
			status: input.status,
			dueAt: input.dueAt,
			closedAt: isClosed ? now : null,
			alreadyRefunded: Boolean(input.alreadyRefunded),
			openedNotifiedAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing()
		.returning({ id: PaymentDispute.id })

	if (!inserted) {
		// Concurrent webhook won the race (or a minimal DB mock returned no row):
		// idempotent no-op.
		const [raced] = await db
			.select({ id: PaymentDispute.id })
			.from(PaymentDispute)
			.where(
				and(
					eq(PaymentDispute.provider, input.provider),
					eq(PaymentDispute.providerDisputeId, input.providerDisputeId),
				),
			)
			.limit(1)
		return {
			id: raced?.id ?? input.providerDisputeId,
			created: false,
			notified: 0,
		}
	}

	const notified = await notifyManagersAboutDispute({
		organizationId: input.organizationId,
		disputeId: inserted.id,
		orderRef: input.orderRef,
		amountMinor: input.amountMinor,
		currency: input.currency.toUpperCase(),
		dueAt: input.dueAt,
		kind: 'opened',
	})

	return { id: inserted.id, created: true, notified }
}

/**
 * Submit evidence once for an open dispute (#187). Throws 409 if already
 * submitted or closed so an answer can only be submitted once.
 */
export async function submitDisputeEvidenceForOrg(input: {
	organizationId: string
	disputeId: string
	evidence: DisputeEvidencePayload
	now?: Date
}) {
	const now = input.now ?? new Date()
	const [dispute] = await db
		.select()
		.from(PaymentDispute)
		.where(
			and(
				eq(PaymentDispute.id, input.disputeId),
				eq(PaymentDispute.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!dispute) {
		throw new Response('Dispute not found', { status: 404 })
	}
	if (dispute.submittedAt || dispute.status !== 'needs_response') {
		throw new Response('Dispute has already been answered or closed', {
			status: 409,
		})
	}

	const isMock = getPaymentsMockStatus().enabled
	await submitProviderDisputeEvidence({
		provider: dispute.provider === 'checkout' ? 'checkout' : 'connect',
		providerDisputeId: dispute.providerDisputeId,
		evidence: {
			...input.evidence,
			...(dispute.alreadyRefunded && !input.evidence.refundReference
				? { refundReference: `Already refunded (${dispute.orderRef})` }
				: {}),
		},
		stripe,
		isMock,
	})

	await db
		.update(PaymentDispute)
		.set({
			status: 'under_review',
			submittedAt: now,
			updatedAt: now,
		})
		.where(eq(PaymentDispute.id, dispute.id))

	return { id: dispute.id, status: 'under_review' as const, submittedAt: now }
}

/**
 * Accept a dispute once (#187). Throws 409 if already answered or closed.
 */
export async function acceptDisputeForOrg(input: {
	organizationId: string
	disputeId: string
	now?: Date
}) {
	const now = input.now ?? new Date()
	const [dispute] = await db
		.select()
		.from(PaymentDispute)
		.where(
			and(
				eq(PaymentDispute.id, input.disputeId),
				eq(PaymentDispute.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!dispute) {
		throw new Response('Dispute not found', { status: 404 })
	}
	if (dispute.submittedAt || dispute.status !== 'needs_response') {
		throw new Response('Dispute has already been answered or closed', {
			status: 409,
		})
	}

	const isMock = getPaymentsMockStatus().enabled
	await acceptProviderDispute({
		provider: dispute.provider === 'checkout' ? 'checkout' : 'connect',
		providerDisputeId: dispute.providerDisputeId,
		stripe,
		isMock,
	})

	await db
		.update(PaymentDispute)
		.set({
			status: 'accepted',
			submittedAt: now,
			closedAt: now,
			updatedAt: now,
		})
		.where(eq(PaymentDispute.id, dispute.id))

	return { id: dispute.id, status: 'accepted' as const, submittedAt: now }
}

/**
 * Daily reminder (#187): notifies managers once when a `needs_response` dispute
 * is within 3 days of its deadline.
 */
export async function runDailyDisputeDeadlineReminders(
	nowMs = Date.now(),
): Promise<{ checked: number; reminded: number }> {
	const cutoff = new Date(nowMs + DISPUTE_REMINDER_WINDOW_MS)
	const nowDate = new Date(nowMs)

	const rows = await db
		.select()
		.from(PaymentDispute)
		.where(
			and(
				eq(PaymentDispute.status, 'needs_response'),
				isNull(PaymentDispute.reminderSentAt),
				lte(PaymentDispute.dueAt, cutoff),
				gte(PaymentDispute.dueAt, nowDate),
			),
		)

	let reminded = 0
	for (const row of rows) {
		const sent = await notifyManagersAboutDispute({
			organizationId: row.organizationId,
			disputeId: row.id,
			orderRef: row.orderRef,
			amountMinor: row.amountMinor,
			currency: row.currency,
			dueAt: row.dueAt,
			kind: 'reminder',
		})
		reminded += sent
		await db
			.update(PaymentDispute)
			.set({ reminderSentAt: nowDate, updatedAt: nowDate })
			.where(eq(PaymentDispute.id, row.id))
	}

	return { checked: rows.length, reminded }
}

export async function listOrganizationDisputes(organizationId: string) {
	return db
		.select()
		.from(PaymentDispute)
		.where(eq(PaymentDispute.organizationId, organizationId))
		.orderBy(desc(PaymentDispute.createdAt))
}

/**
 * Period summary of disputed amounts and dispute fees per currency (#187 Reports).
 */
export async function summarizeDisputesForPeriod(input: {
	organizationId: string
	from?: Date
	to?: Date
}): Promise<
	Array<{
		currency: string
		disputeCount: number
		disputedAmountMinor: number
		disputeFeesMinor: number
		lostAmountMinor: number
		openCount: number
		wonCount: number
		lostCount: number
	}>
> {
	const conditions = [eq(PaymentDispute.organizationId, input.organizationId)]
	if (input.from) conditions.push(gte(PaymentDispute.createdAt, input.from))
	if (input.to) conditions.push(lte(PaymentDispute.createdAt, input.to))
	const rows = await db
		.select()
		.from(PaymentDispute)
		.where(and(...conditions))

	const byCurrency = new Map<
		string,
		{
			currency: string
			disputeCount: number
			disputedAmountMinor: number
			disputeFeesMinor: number
			lostAmountMinor: number
			openCount: number
			wonCount: number
			lostCount: number
		}
	>()

	for (const row of rows) {
		const cur = row.currency.toUpperCase()
		const entry = byCurrency.get(cur) ?? {
			currency: cur,
			disputeCount: 0,
			disputedAmountMinor: 0,
			disputeFeesMinor: 0,
			lostAmountMinor: 0,
			openCount: 0,
			wonCount: 0,
			lostCount: 0,
		}
		entry.disputeCount += 1
		entry.disputedAmountMinor += row.amountMinor
		entry.disputeFeesMinor += row.feeMinor
		if (row.status === 'lost' || row.status === 'accepted') {
			entry.lostAmountMinor += row.amountMinor
			entry.lostCount += 1
		} else if (row.status === 'won') {
			entry.wonCount += 1
		} else {
			entry.openCount += 1
		}
		byCurrency.set(cur, entry)
	}

	return [...byCurrency.values()].sort((a, b) =>
		a.currency.localeCompare(b.currency),
	)
}
