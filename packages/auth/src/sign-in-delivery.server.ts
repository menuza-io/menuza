import { createHmac } from 'node:crypto'
import {
	DELIVERY_STATUSES,
	SIGN_IN_DELIVERY_RETENTION_MS,
	type DeliveryStatus,
	type NumberCheck,
	type SignInChannel,
	type SignInCodePurpose,
	type SignInProvider,
	maskEmail,
	maskPhone,
	mergeDeliveryStatus,
	statusFromResendEvent,
} from '@repo/common/sign-in-delivery'
import { SignInCodeDelivery, and, db, desc, eq, gt, lt } from '@repo/database'
import { ENV } from './package-env.js'

/**
 * The delivery log of sign-in codes (#246). It records that a code was SENT, to
 * whom (a keyed hash and a masked hint), by which provider, and what the provider
 * reported. The functions below take no code and the table has no column for
 * one: nothing logged here can be turned back into a code. Rows live 7 days.
 */

function secret(): string {
	return ENV.SESSION_SECRET.split(',')[0]!.trim()
}

/** Normalizes an address (lower case) or a number (digits and a leading +). */
export function normalizeDestination(channel: SignInChannel, value: string) {
	return channel === 'email'
		? value.trim().toLowerCase()
		: `+${value.replace(/[^\d]/g, '')}`
}

/** A keyed hash: finds rows by address or number without storing either. */
export function destinationHash(channel: SignInChannel, value: string) {
	return createHmac('sha256', secret())
		.update(
			`sign-in-delivery:${channel}:${normalizeDestination(channel, value)}`,
		)
		.digest('hex')
}

export function destinationHint(channel: SignInChannel, value: string) {
	const normalized = normalizeDestination(channel, value)
	return channel === 'email' ? maskEmail(normalized) : maskPhone(normalized)
}

export async function recordSignInCodeDelivery(input: {
	userId?: string | null
	organizationId?: string | null
	purpose: SignInCodePurpose
	channel: SignInChannel
	/** The address or number the code went to. Hashed and masked here; never stored. */
	destination: string
	provider: SignInProvider
	providerMessageId?: string | null
	status?: DeliveryStatus
	failureReason?: string | null
	now?: Date
}): Promise<string | null> {
	const now = input.now ?? new Date()
	try {
		const [row] = await db
			.insert(SignInCodeDelivery)
			.values({
				userId: input.userId ?? null,
				organizationId: input.organizationId ?? null,
				purpose: input.purpose,
				channel: input.channel,
				destinationHash: destinationHash(input.channel, input.destination),
				destinationHint: destinationHint(input.channel, input.destination),
				provider: input.provider,
				providerMessageId: input.providerMessageId ?? null,
				status: input.status ?? 'sent',
				failureReason: input.failureReason?.slice(0, 120) ?? null,
				createdAt: now,
				statusAt: now,
				expiresAt: new Date(now.getTime() + SIGN_IN_DELIVERY_RETENTION_MS),
			})
			.onConflictDoNothing()
			.returning({ id: SignInCodeDelivery.id })
		return row?.id ?? null
	} catch (error) {
		// Logging a send never fails the send.
		console.error('Could not record a sign-in code delivery', {
			purpose: input.purpose,
			error: error instanceof Error ? error.name : 'unknown',
		})
		return null
	}
}

/**
 * A provider's delivery event (a webhook or a status call). Events arrive out of
 * order, so the later stage is kept (`delivered` is not undone by a late
 * `sent`). Returns whether a logged send matched.
 */
export async function applyDeliveryStatus(input: {
	provider: SignInProvider
	providerMessageId: string
	status: DeliveryStatus
	failureReason?: string | null
	at?: Date
}): Promise<boolean> {
	if (!DELIVERY_STATUSES.includes(input.status)) return false
	const [row] = await db
		.select({
			id: SignInCodeDelivery.id,
			status: SignInCodeDelivery.status,
			failureReason: SignInCodeDelivery.failureReason,
		})
		.from(SignInCodeDelivery)
		.where(
			and(
				eq(SignInCodeDelivery.provider, input.provider),
				eq(SignInCodeDelivery.providerMessageId, input.providerMessageId),
			),
		)
		.limit(1)
	if (!row) return false
	const merged = mergeDeliveryStatus(row.status as DeliveryStatus, input.status)
	await db
		.update(SignInCodeDelivery)
		.set({
			status: merged,
			failureReason:
				merged === input.status
					? (input.failureReason?.slice(0, 120) ?? row.failureReason)
					: row.failureReason,
			statusAt: input.at ?? new Date(),
		})
		.where(eq(SignInCodeDelivery.id, row.id))
	return true
}

/**
 * A Resend webhook event for a logged send (`email.delivered`, `email.bounced`,
 * and so on). Anything that is not a delivery event, or not one of ours, is
 * ignored. The bounce reason is Resend's category (for example `Permanent`),
 * never the message.
 */
export async function applyResendDeliveryEvent(
	event: unknown,
): Promise<boolean> {
	if (!event || typeof event !== 'object') return false
	const { type, data, created_at } = event as {
		type?: unknown
		created_at?: unknown
		data?: {
			email_id?: unknown
			bounce?: { type?: unknown; subType?: unknown }
		}
	}
	const status = statusFromResendEvent(type)
	const emailId = data?.email_id
	if (!status || typeof emailId !== 'string') return false
	const bounceType =
		typeof data?.bounce?.type === 'string' ? data.bounce.type : null
	const bounceSubType =
		typeof data?.bounce?.subType === 'string' ? data.bounce.subType : null
	const reason =
		status === 'bounced'
			? [bounceType, bounceSubType].filter(Boolean).join('_').toLowerCase() ||
				'bounced'
			: status === 'complained'
				? 'marked_as_spam'
				: status === 'failed'
					? 'send_failed'
					: null
	return applyDeliveryStatus({
		provider: 'resend',
		providerMessageId: emailId,
		status,
		failureReason: reason,
		at: typeof created_at === 'string' ? new Date(created_at) : undefined,
	})
}

/** Remembers what the text provider's lookup said about a number, on its recent rows. */
export async function recordNumberCheck(input: {
	phone: string
	check: NumberCheck
	now?: Date
}) {
	const now = input.now ?? new Date()
	await db
		.update(SignInCodeDelivery)
		.set({
			numberValid: input.check.valid,
			lineType: input.check.lineType,
			carrier: input.check.carrier,
			lookedUpAt: now,
		})
		.where(
			and(
				eq(
					SignInCodeDelivery.destinationHash,
					destinationHash('sms', input.phone),
				),
				gt(SignInCodeDelivery.expiresAt, now),
			),
		)
}

export type DeliveryRow = typeof SignInCodeDelivery.$inferSelect

/** The last week of sends to a person or to a destination, newest first. */
export async function listSignInDeliveries(input: {
	userId?: string
	destination?: { channel: SignInChannel; value: string }
	now?: Date
	limit?: number
}): Promise<DeliveryRow[]> {
	const now = input.now ?? new Date()
	if (!input.userId && !input.destination) return []
	return db
		.select()
		.from(SignInCodeDelivery)
		.where(
			and(
				gt(SignInCodeDelivery.expiresAt, now),
				input.userId
					? eq(SignInCodeDelivery.userId, input.userId)
					: eq(
							SignInCodeDelivery.destinationHash,
							destinationHash(
								input.destination!.channel,
								input.destination!.value,
							),
						),
			),
		)
		.orderBy(desc(SignInCodeDelivery.createdAt))
		.limit(input.limit ?? 50)
}

/** Deletes rows past their 7 days. Run by the hourly sweep. */
export async function pruneSignInDeliveries(now = new Date()): Promise<number> {
	const removed = await db
		.delete(SignInCodeDelivery)
		.where(lt(SignInCodeDelivery.expiresAt, now))
		.returning({ id: SignInCodeDelivery.id })
	return removed.length
}
