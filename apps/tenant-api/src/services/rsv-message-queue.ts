import { channelsFor, dedupeKey, scheduleFor } from '@repo/reservations'
import {
	rsvGuests,
	rsvLocationSettings,
	rsvMessages,
	rsvNotifyRequests,
	rsvReservations,
	rsvWaitlistEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
	resolveMessagingSettings,
	type ResolvedMessagingSettings,
	type ToggleableMessageKind,
} from '../lib/reservations-messaging-settings.ts'
import { forEachInChunks, queryInChunks } from '../lib/chunked-in.ts'
import { getNodeRegion } from '../lib/region.ts'
import { type ReservationWriteTx } from '../lib/reservations-write.ts'
import { loadBookingContacts } from './rsv-booking-contact.ts'

/**
 * Enqueue side of guest messages. Everything here runs inside the caller's
 * write transaction and only inserts or cancels `rsv_messages` rows; sending
 * is `rsv-message-service.ts`, after commit or from the tick. The destination
 * is never copied onto the row, so a guest erased later needs no rewrite.
 */

type Tx = ReservationWriteTx | TenantDatabase

export type QueueContext = {
	orgId: string
	now: number
	afterCommit?: (hook: () => void | Promise<void>) => void
}

export type ReservationMessageKind = Extract<
	ToggleableMessageKind,
	| 'confirmation'
	| 'modification'
	| 'cancellation_guest'
	| 'cancellation_restaurant'
	| 'reminder'
	| 'reconfirm_request'
	| 'request_received'
	| 'request_approved'
	| 'request_declined'
>

export const SCHEDULED_KINDS = ['reminder', 'reconfirm_request'] as const

const REMINDER_ELIGIBLE = new Set(['booked', 'confirmed'])

function nodeRegion(): 'us' | 'ksa' {
	try {
		return getNodeRegion()
	} catch {
		return 'us'
	}
}

export async function loadMessagingSettings(
	tx: Tx,
	locationId: string,
): Promise<ResolvedMessagingSettings> {
	const row = await tx
		.select({ messaging: rsvLocationSettings.messaging })
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	return resolveMessagingSettings(row?.messaging)
}

type InsertRow = typeof rsvMessages.$inferInsert

async function insertMessages(tx: Tx, rows: InsertRow[]): Promise<string[]> {
	const inserted: string[] = []
	for (const row of rows) {
		const result = await tx
			.insert(rsvMessages)
			.values(row)
			.onConflictDoNothing({ target: rsvMessages.dedupeKey })
			.returning({ id: rsvMessages.id })
		if (result[0]) inserted.push(result[0].id)
	}
	return inserted
}

/**
 * Scheduled rows follow the booking and the settings: a pending row whose
 * time moved is retimed, and a row cancelled earlier (kind switched off, then
 * on again) is revived. A row in any other state (sending, sent, failed,
 * suppressed) is never touched, and an untouched pending row keeps its retry
 * state.
 */
async function upsertScheduledMessages(
	tx: Tx,
	rows: InsertRow[],
): Promise<void> {
	for (const row of rows) {
		await tx
			.insert(rsvMessages)
			.values(row)
			.onConflictDoUpdate({
				target: rsvMessages.dedupeKey,
				set: {
					status: 'pending',
					sendAt: row.sendAt,
					nextAttemptAt: row.sendAt,
					attempts: 0,
				},
				setWhere: sql`(${rsvMessages.status} = 'pending' AND ${rsvMessages.sendAt} != excluded.send_at AND ${rsvMessages.attempts} = 0) OR ${rsvMessages.status} = 'cancelled'`,
			})
	}
}

/** Sends rows that are already due right after the write commits (best effort). */
export function deliverAfterCommit(
	ctx: QueueContext,
	rows: ReadonlyArray<{ id: string; sendAt: number }>,
): void {
	const due = rows.filter((row) => row.sendAt <= ctx.now).map((row) => row.id)
	if (due.length === 0 || !ctx.afterCommit) return
	const orgId = ctx.orgId
	ctx.afterCommit(async () => {
		try {
			const { deliverMessagesByIds } = await import('./rsv-message-service.ts')
			await deliverMessagesByIds(orgId, due)
		} catch {
			// The tick retries anything left pending; a send failure must not fail the write.
		}
	})
}

function messageRow(input: {
	locationId: string
	reservationId?: string
	waitlistEntryId?: string
	notifyRequestId?: string
	kind: InsertRow['kind']
	channel: 'email' | 'sms'
	locale: string
	sendAt: number
	key: string
	now: number
}): InsertRow {
	return {
		locationId: input.locationId,
		reservationId: input.reservationId ?? null,
		waitlistEntryId: input.waitlistEntryId ?? null,
		notifyRequestId: input.notifyRequestId ?? null,
		kind: input.kind,
		channel: input.channel,
		category: 'transactional',
		locale: input.locale,
		sendAt: input.sendAt,
		status: 'pending',
		attempts: 0,
		nextAttemptAt: input.sendAt,
		dedupeKey: input.key,
		createdAt: input.now,
	}
}

/**
 * Queues one announcement for a reservation (confirmation, modification,
 * cancellation, request outcome). `variant` makes a deliberate re-send (the
 * operator's resend button) a new dedupe key instead of a no-op.
 */
export async function enqueueReservationMessage(
	tx: Tx,
	ctx: QueueContext,
	input: {
		reservationId: string
		kind: Exclude<ReservationMessageKind, 'reminder' | 'reconfirm_request'>
		variant?: string | number
		/** An explicit operator action goes out even when the kind is switched off. */
		force?: boolean
	},
): Promise<string[]> {
	const reservation = await tx
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, input.reservationId))
		.get()
	if (!reservation) return []
	const guest = await tx
		.select({
			emailNorm: rsvGuests.emailNorm,
			phoneE164: rsvGuests.phoneE164,
			locale: rsvGuests.locale,
			erasedAt: rsvGuests.erasedAt,
		})
		.from(rsvGuests)
		.where(eq(rsvGuests.id, reservation.guestId))
		.get()
	if (!guest || guest.erasedAt) return []

	const settings = await loadMessagingSettings(tx, reservation.locationId)
	if (!input.force && !settings.kinds[input.kind]) return []
	const bookingContact = (await loadBookingContacts(tx, [reservation.id])).get(
		reservation.id,
	)

	const channels = channelsFor({
		dataRegion: nodeRegion(),
		smsOptIn: reservation.smsOptIn && settings.smsEnabled && !!guest.phoneE164,
		emailProvided: bookingContact ? !!bookingContact.email : !!guest.emailNorm,
	})
	const milestone =
		input.variant === undefined
			? reservation.scheduleVersion
			: `${reservation.scheduleVersion}.${input.variant}`
	const rows = channels.map((channel) =>
		messageRow({
			locationId: reservation.locationId,
			reservationId: reservation.id,
			kind: input.kind,
			channel,
			locale: reservation.guestLocale || guest.locale || '',
			sendAt: ctx.now,
			now: ctx.now,
			key: dedupeKey({
				reservationId: reservation.id,
				kind: input.kind,
				channel,
				milestone,
			}),
		}),
	)
	const ids = await insertMessages(tx, rows)
	deliverAfterCommit(
		ctx,
		ids.map((id) => ({ id, sendAt: ctx.now })),
	)
	return ids
}

/** Cancels pending rows of the given kinds that a state change made pointless. */
export async function cancelPendingReservationMessages(
	tx: Tx,
	reservationId: string,
	kinds: readonly InsertRow['kind'][] = SCHEDULED_KINDS,
	options: { keepVersion?: number } = {},
): Promise<number> {
	const pending = await tx
		.select({ id: rsvMessages.id, dedupeKey: rsvMessages.dedupeKey })
		.from(rsvMessages)
		.where(
			and(
				eq(rsvMessages.reservationId, reservationId),
				eq(rsvMessages.status, 'pending'),
				inArray(rsvMessages.kind, [...kinds]),
			),
		)
	const doomed = pending.filter(
		(row) =>
			options.keepVersion === undefined ||
			!row.dedupeKey.endsWith(`:${options.keepVersion}`),
	)
	if (doomed.length === 0) return 0
	await forEachInChunks(
		doomed.map((row) => row.id),
		(chunk) =>
			tx
				.update(rsvMessages)
				.set({ status: 'cancelled' })
				.where(inArray(rsvMessages.id, chunk)),
	)
	return doomed.length
}

/**
 * Makes the scheduled messages (reminder, reconfirmation) of every reservation
 * on the affected days match its current state: rows exist for the current
 * `schedule_version`, and pending rows of an older version or of a reservation
 * that is no longer upcoming are cancelled. Idempotent, so every write can call
 * it without tracking which mutation changed what.
 */
export async function reconcileScheduledMessages(
	tx: Tx,
	ctx: QueueContext,
	input: { locationId: string; dates: readonly string[] },
): Promise<void> {
	if (input.dates.length === 0) return
	const reservations = await tx
		.select()
		.from(rsvReservations)
		.where(
			and(
				eq(rsvReservations.locationId, input.locationId),
				inArray(rsvReservations.businessDate, [...input.dates]),
			),
		)
	if (reservations.length === 0) return
	const ids = reservations.map((row) => row.id)

	const pending = await queryInChunks(ids, (chunk) =>
		tx
			.select({
				id: rsvMessages.id,
				reservationId: rsvMessages.reservationId,
				kind: rsvMessages.kind,
				dedupeKey: rsvMessages.dedupeKey,
			})
			.from(rsvMessages)
			.where(
				and(
					inArray(rsvMessages.reservationId, chunk),
					eq(rsvMessages.status, 'pending'),
					inArray(rsvMessages.kind, [...SCHEDULED_KINDS]),
				),
			),
	)
	const settings = await loadMessagingSettings(tx, input.locationId)
	const guestIds = [...new Set(reservations.map((row) => row.guestId))]
	const guests = await queryInChunks(guestIds, (chunk) =>
		tx
			.select({
				id: rsvGuests.id,
				emailNorm: rsvGuests.emailNorm,
				phoneE164: rsvGuests.phoneE164,
				locale: rsvGuests.locale,
				erasedAt: rsvGuests.erasedAt,
			})
			.from(rsvGuests)
			.where(inArray(rsvGuests.id, chunk)),
	)
	const guestById = new Map(guests.map((guest) => [guest.id, guest]))
	const region = nodeRegion()
	const contactByReservation = await loadBookingContacts(tx, ids)

	const doomed: string[] = []
	const inserts: InsertRow[] = []
	for (const reservation of reservations) {
		const upcoming =
			REMINDER_ELIGIBLE.has(reservation.status) && reservation.startAt > ctx.now
		const wanted = new Set<string>()
		if (upcoming && settings.kinds.reminder) wanted.add('reminder')
		if (
			upcoming &&
			reservation.status === 'booked' &&
			settings.kinds.reconfirm_request
		) {
			wanted.add('reconfirm_request')
		}
		const version = reservation.scheduleVersion
		for (const row of pending) {
			if (row.reservationId !== reservation.id) continue
			if (!wanted.has(row.kind) || !row.dedupeKey.endsWith(`:${version}`)) {
				doomed.push(row.id)
			}
		}
		if (wanted.size === 0) continue
		const guest = guestById.get(reservation.guestId)
		if (!guest || guest.erasedAt) continue
		const channels = channelsFor({
			dataRegion: region,
			smsOptIn:
				reservation.smsOptIn && settings.smsEnabled && !!guest.phoneE164,
			emailProvided: contactByReservation.has(reservation.id)
				? !!contactByReservation.get(reservation.id)?.email
				: !!guest.emailNorm,
		})
		for (const kind of wanted as Set<'reminder' | 'reconfirm_request'>) {
			const schedule = scheduleFor({
				kind,
				startAtMs: reservation.startAt,
				nowMs: ctx.now,
				timeZone: reservation.timeZone,
				quietHours: settings.quietHours,
				leadMin:
					(kind === 'reminder'
						? settings.reminderHours
						: settings.reconfirmHours) * 60,
			})
			if (schedule.skip || schedule.scheduledForMs === null) continue
			for (const channel of channels) {
				inserts.push(
					messageRow({
						locationId: reservation.locationId,
						reservationId: reservation.id,
						kind,
						channel,
						locale: reservation.guestLocale || guest.locale || '',
						sendAt: schedule.scheduledForMs,
						now: ctx.now,
						key: dedupeKey({
							reservationId: reservation.id,
							kind,
							channel,
							milestone: version,
						}),
					}),
				)
			}
		}
	}

	if (doomed.length > 0) {
		await forEachInChunks(doomed, (chunk) =>
			tx
				.update(rsvMessages)
				.set({ status: 'cancelled' })
				.where(inArray(rsvMessages.id, chunk)),
		)
	}
	await upsertScheduledMessages(tx, inserts)
}

type WaitlistKind = 'waitlist_joined' | 'waitlist_ready'

/** Queues a waitlist message; the destination comes from the entry at send time. */
export async function enqueueWaitlistMessage(
	tx: Tx,
	ctx: QueueContext,
	input: { entryId: string; kind: WaitlistKind; milestone?: string | number },
): Promise<string[]> {
	const entry = await tx
		.select()
		.from(rsvWaitlistEntries)
		.where(eq(rsvWaitlistEntries.id, input.entryId))
		.get()
	if (!entry) return []
	const settings = await loadMessagingSettings(tx, entry.locationId)
	if (!settings.kinds[input.kind]) return []
	const channels = channelsFor({
		dataRegion: nodeRegion(),
		smsOptIn: entry.smsOptIn && settings.smsEnabled && !!entry.phoneE164,
		emailProvided: !!entry.emailNorm,
	})
	const rows = channels.map((channel) =>
		messageRow({
			locationId: entry.locationId,
			waitlistEntryId: entry.id,
			kind: input.kind,
			channel,
			locale: entry.locale || '',
			sendAt: ctx.now,
			now: ctx.now,
			key: dedupeKey({
				waitlistId: entry.id,
				kind: input.kind,
				channel,
				milestone: input.milestone ?? 1,
			}),
		}),
	)
	const ids = await insertMessages(tx, rows)
	deliverAfterCommit(
		ctx,
		ids.map((id) => ({ id, sendAt: ctx.now })),
	)
	return ids
}

/** Queues `notify_available`; each notification of a request is its own milestone. */
export async function enqueueNotifyMessage(
	tx: Tx,
	ctx: QueueContext,
	input: { requestId: string; milestone: number },
): Promise<string[]> {
	const request = await tx
		.select()
		.from(rsvNotifyRequests)
		.where(eq(rsvNotifyRequests.id, input.requestId))
		.get()
	if (!request) return []
	const settings = await loadMessagingSettings(tx, request.locationId)
	if (!settings.kinds.notify_available) return []
	const channels = channelsFor({
		dataRegion: nodeRegion(),
		smsOptIn: !!request.contactPhoneE164 && settings.smsEnabled,
		emailProvided: !!request.contactEmailNorm,
	})
	const rows = channels.map((channel) =>
		messageRow({
			locationId: request.locationId,
			notifyRequestId: request.id,
			kind: 'notify_available',
			channel,
			locale: request.locale || '',
			sendAt: ctx.now,
			now: ctx.now,
			key: dedupeKey({
				notifyRequestId: request.id,
				kind: 'notify_available',
				channel,
				milestone: input.milestone,
			}),
		}),
	)
	const ids = await insertMessages(tx, rows)
	deliverAfterCommit(
		ctx,
		ids.map((id) => ({ id, sendAt: ctx.now })),
	)
	return ids
}

/** Payment-flow message kinds: they follow the payment state, not a message setting. */
export const PAYMENT_MESSAGE_KINDS = [
	'payment_received',
	'refund_issued',
	'fee_charged',
	'fee_action_required',
	'late_payment_refunded',
] as const
export type PaymentMessageKind = (typeof PAYMENT_MESSAGE_KINDS)[number]

export function isPaymentMessageKind(kind: string): kind is PaymentMessageKind {
	return (PAYMENT_MESSAGE_KINDS as readonly string[]).includes(kind)
}

/**
 * Queues one payment message for a reservation. The payment row id is the
 * dedupe milestone, so a duplicate webhook, poll or flush queues nothing new.
 * Channels follow the regional rule (SMS only in the US, only with opt-in);
 * the amount and pay link are resolved from the payment row at send time.
 */
export async function enqueuePaymentMessage(
	tx: Tx,
	ctx: QueueContext,
	input: {
		reservationId: string
		kind: PaymentMessageKind
		paymentId: string
	},
): Promise<string[]> {
	const reservation = await tx
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, input.reservationId))
		.get()
	if (!reservation) return []
	const guest = await tx
		.select({
			emailNorm: rsvGuests.emailNorm,
			phoneE164: rsvGuests.phoneE164,
			locale: rsvGuests.locale,
			erasedAt: rsvGuests.erasedAt,
		})
		.from(rsvGuests)
		.where(eq(rsvGuests.id, reservation.guestId))
		.get()
	if (!guest || guest.erasedAt) return []
	const settings = await loadMessagingSettings(tx, reservation.locationId)
	const bookingContact = (await loadBookingContacts(tx, [reservation.id])).get(
		reservation.id,
	)
	const channels = channelsFor({
		dataRegion: nodeRegion(),
		smsOptIn: reservation.smsOptIn && settings.smsEnabled && !!guest.phoneE164,
		emailProvided: bookingContact ? !!bookingContact.email : !!guest.emailNorm,
	})
	const rows = channels.map((channel) =>
		messageRow({
			locationId: reservation.locationId,
			reservationId: reservation.id,
			kind: input.kind,
			channel,
			locale: reservation.guestLocale || guest.locale || '',
			sendAt: ctx.now,
			now: ctx.now,
			key: dedupeKey({
				reservationId: reservation.id,
				kind: input.kind,
				channel,
				milestone: input.paymentId,
			}),
		}),
	)
	const ids = await insertMessages(tx, rows)
	deliverAfterCommit(
		ctx,
		ids.map((id) => ({ id, sendAt: ctx.now })),
	)
	return ids
}
