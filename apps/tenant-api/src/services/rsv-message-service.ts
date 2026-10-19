import {
	getTenantDb,
	rsvGuests,
	rsvLocationSettings,
	rsvMessages,
	rsvMessageTexts,
	rsvNotifyRequests,
	rsvPayments,
	rsvReservations,
	rsvWaitlistEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	localToInstant,
	resolveGuestLocale,
	type ReservationsContext,
} from '@repo/reservations'
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { getNodeRegion } from '../lib/region.ts'
import {
	buildCalendarUrl,
	normalizeReservationLocale,
	renderReservationEmail,
	type PaymentEmailKind,
	type ReservationEmailLocale,
} from '../lib/reservations-email.ts'
import { type ToggleableMessageKind } from '../lib/reservations-messaging-settings.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import {
	deriveFeePayToken,
	deriveManageToken,
	deriveNotifyToken,
	deriveWaitlistToken,
} from '../lib/reservations-public-auth.ts'
import {
	renderReservationSms,
	sendReservationSms,
} from '../lib/reservations-sms.ts'
import {
	isReservationsEmailEnabled,
	isReservationsSmsEnabled,
} from '../lib/reservations-switches.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { loadBookingContacts } from './rsv-booking-contact.ts'
import { isPaymentMessageKind } from './rsv-message-queue.ts'
import { enqueueManagerAlert } from './rsv-outbox.ts'

/**
 * Sends `rsv_messages` rows. A row is claimed, re-checked against the current
 * state (a reminder for a booking that moved or was cancelled is never sent),
 * rendered with the organization's email theme, and delivered. The destination
 * is read from the guest at send time, so an erased guest has none and the row
 * is suppressed. A failed send is retried after 1, 5 and 30 minutes and then
 * ends `failed`; only an error code is stored.
 */

export const DELIVER_BATCH_LIMIT = 100
export const RETRY_BACKOFF_MIN = [1, 5, 30] as const
const CLAIM_LEASE_MS = 5 * 60 * 1000
const HOLD_MS = 10 * 60 * 1000
export const BULK_FAILURE_THRESHOLD = 10
export const BULK_FAILURE_WINDOW_MS = 15 * 60 * 1000

type MessageRow = typeof rsvMessages.$inferSelect

const WAITLIST_FLAG_KINDS = new Set<string>([
	'waitlist_joined',
	'waitlist_ready',
	'notify_available',
])
const DEAD_STATUSES = new Set(['cancelled', 'declined', 'expired', 'no_show'])

export type DeliveryTotals = {
	sent: number
	failed: number
	retried: number
	suppressed: number
	dropped: number
	cancelled: number
	held: number
}

export function emptyDeliveryTotals(): DeliveryTotals {
	return {
		sent: 0,
		failed: 0,
		retried: 0,
		suppressed: 0,
		dropped: 0,
		cancelled: 0,
		held: 0,
	}
}

type Outcome = keyof DeliveryTotals

function milestoneOf(dedupeKey: string): string {
	return dedupeKey.slice(dedupeKey.lastIndexOf(':') + 1)
}

function siteBase(context: ReservationsContext, locale: string): string | null {
	const origin = context.organization.siteOrigin
	if (!origin) return null
	const base = origin.replace(/\/$/, '')
	const { defaultLocale, locales } = context.organization
	return locale !== defaultLocale && locales.includes(locale)
		? `${base}/${locale}`
		: base
}

/**
 * The operator's note for the guest's language, else for the organization's
 * default language, else none. Notes are never machine-translated at send time.
 */
async function customNoteFor(
	db: TenantDatabase,
	locationId: string,
	kind: string,
	locale: string,
	defaultLocale: string,
): Promise<string | null> {
	const wanted = [...new Set([locale, defaultLocale])] as Array<
		(typeof rsvMessageTexts.$inferSelect)['locale']
	>
	const rows = await db
		.select({
			locationId: rsvMessageTexts.locationId,
			locale: rsvMessageTexts.locale,
			customNote: rsvMessageTexts.customNote,
		})
		.from(rsvMessageTexts)
		.where(
			and(
				eq(rsvMessageTexts.kind, kind as MessageRow['kind']),
				// bounded: at most two locales
				inArray(rsvMessageTexts.locale, wanted),
				or(
					eq(rsvMessageTexts.locationId, locationId),
					isNull(rsvMessageTexts.locationId),
				),
			),
		)
	for (const candidate of wanted) {
		const specific = rows.find(
			(row) => row.locale === candidate && row.locationId === locationId,
		)
		const orgWide = rows.find(
			(row) => row.locale === candidate && row.locationId === null,
		)
		const note = specific?.customNote?.trim() || orgWide?.customNote?.trim()
		if (note) return note
	}
	return null
}

type Subject = {
	kind: 'reservation' | 'waitlist' | 'notify'
	locationId: string
	email: string | null
	phone: string | null
	smsAllowed: boolean
	firstName: string | null
	locale: string
	whenMs: number | null
	timeZone: string | null
	partySize: number | null
	token: string | null
	endMs: number | null
	quotedWaitMin: number | null
	/** Query of the booking link that opens the offered slot (notify-me only). */
	bookQuery: string | null
	/** Amount and id of the payment a payment message is about. */
	payment: {
		id: string
		amountMinor: number
		currency: string
	} | null
}

type Resolved =
	| { ok: true; subject: Subject }
	| { ok: false; outcome: 'cancelled' | 'suppressed'; code: string }

async function resolveSubject(
	db: TenantDatabase,
	orgId: string,
	row: MessageRow,
	now: number,
): Promise<Resolved> {
	if (row.reservationId) {
		const reservation = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, row.reservationId))
			.get()
		if (!reservation) {
			return { ok: false, outcome: 'cancelled', code: 'reservation_missing' }
		}
		const guest = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, reservation.guestId))
			.get()
		const scheduled =
			row.kind === 'reminder' || row.kind === 'reconfirm_request'
		if (scheduled) {
			const eligible =
				(reservation.status === 'booked' ||
					(reservation.status === 'confirmed' && row.kind === 'reminder')) &&
				reservation.startAt > now
			if (!eligible) {
				return { ok: false, outcome: 'cancelled', code: 'not_eligible' }
			}
			if (milestoneOf(row.dedupeKey) !== String(reservation.scheduleVersion)) {
				return { ok: false, outcome: 'cancelled', code: 'stale_schedule' }
			}
		} else if (
			(row.kind === 'confirmation' || row.kind === 'modification') &&
			DEAD_STATUSES.has(reservation.status)
		) {
			return { ok: false, outcome: 'suppressed', code: 'not_eligible' }
		}
		if (!guest || guest.erasedAt) {
			return { ok: false, outcome: 'suppressed', code: 'guest_erased' }
		}
		let payment: Subject['payment'] = null
		if (isPaymentMessageKind(row.kind)) {
			const paymentRow = await db
				.select({
					id: rsvPayments.id,
					amountMinor: rsvPayments.amountMinor,
					currency: rsvPayments.currency,
					reservationId: rsvPayments.reservationId,
				})
				.from(rsvPayments)
				.where(eq(rsvPayments.id, milestoneOf(row.dedupeKey)))
				.get()
			if (!paymentRow || paymentRow.reservationId !== reservation.id) {
				return { ok: false, outcome: 'cancelled', code: 'payment_missing' }
			}
			payment = paymentRow
		}
		// A public booking messages the contact typed for THAT booking, not
		// whatever a profile with the same phone number holds.
		const bookingContact = (
			await loadBookingContacts(db, [reservation.id])
		).get(reservation.id)
		return {
			ok: true,
			subject: {
				kind: 'reservation',
				locationId: reservation.locationId,
				email: bookingContact ? bookingContact.email : guest.emailNorm,
				phone: guest.phoneE164,
				smsAllowed: reservation.smsOptIn,
				firstName: bookingContact ? bookingContact.firstName : guest.firstName,
				locale: row.locale || reservation.guestLocale,
				whenMs: reservation.startAt,
				timeZone: reservation.timeZone,
				partySize: reservation.partySize,
				token: deriveManageToken(
					orgId,
					reservation.id,
					reservation.manageTokenVersion,
				),
				endMs: reservation.endAt,
				quotedWaitMin: null,
				bookQuery: null,
				payment,
			},
		}
	}
	if (row.waitlistEntryId) {
		const entry = await db
			.select()
			.from(rsvWaitlistEntries)
			.where(eq(rsvWaitlistEntries.id, row.waitlistEntryId))
			.get()
		if (!entry) {
			return { ok: false, outcome: 'cancelled', code: 'entry_missing' }
		}
		if (
			row.kind === 'waitlist_ready' &&
			!['notified', 'on_the_way'].includes(entry.status)
		) {
			return { ok: false, outcome: 'suppressed', code: 'not_eligible' }
		}
		if (
			row.kind === 'waitlist_joined' &&
			['cancelled', 'left', 'seated'].includes(entry.status)
		) {
			return { ok: false, outcome: 'suppressed', code: 'not_eligible' }
		}
		return {
			ok: true,
			subject: {
				kind: 'waitlist',
				locationId: entry.locationId,
				email: entry.emailNorm,
				phone: entry.phoneE164,
				smsAllowed: entry.smsOptIn,
				firstName: entry.displayName.split(' ')[0] || null,
				locale: row.locale || entry.locale,
				whenMs: entry.quotedReadyAt,
				timeZone: null,
				partySize: entry.partySize,
				token: deriveWaitlistToken(orgId, entry.id, entry.statusTokenVersion),
				endMs: null,
				quotedWaitMin: entry.quotedMin,
				bookQuery: null,
				payment: null,
			},
		}
	}
	if (row.notifyRequestId) {
		const request = await db
			.select()
			.from(rsvNotifyRequests)
			.where(eq(rsvNotifyRequests.id, row.notifyRequestId))
			.get()
		if (!request) {
			return { ok: false, outcome: 'cancelled', code: 'request_missing' }
		}
		// The slot the last notification offered; a request that was never
		// notified falls back to the start of its window.
		const slotMin = request.lastNotifiedSlotMin ?? request.fromLocalMin
		const zone = await locationTimeZone(db, request.locationId)
		const instant = localToInstant(request.businessDate, slotMin, zone)
		const hh = String(Math.floor(slotMin / 60) % 24).padStart(2, '0')
		const mm = String(slotMin % 60).padStart(2, '0')
		return {
			ok: true,
			subject: {
				kind: 'notify',
				locationId: request.locationId,
				email: request.contactEmailNorm,
				phone: request.contactPhoneE164,
				smsAllowed: true,
				firstName: null,
				locale: row.locale || request.locale,
				whenMs: instant?.instantMs ?? null,
				timeZone: zone,
				partySize: request.partySize,
				token: deriveNotifyToken(orgId, request.id, request.tokenVersion),
				endMs: null,
				quotedWaitMin: null,
				payment: null,
				bookQuery: new URLSearchParams({
					location: request.locationId,
					party: String(request.partySize),
					date: request.businessDate,
					time: `${hh}:${mm}`,
				}).toString(),
			},
		}
	}
	return { ok: false, outcome: 'cancelled', code: 'no_subject' }
}

async function locationTimeZone(
	db: TenantDatabase,
	locationId: string,
): Promise<string> {
	const settings = await db
		.select({ timeZone: rsvLocationSettings.timeZone })
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	return settings?.timeZone ?? 'UTC'
}

async function sendOne(options: {
	db: TenantDatabase
	orgId: string
	context: ReservationsContext
	row: MessageRow
	subject: Subject
	now: number
}): Promise<void> {
	const { db, orgId, context, row, subject } = options
	const locale = normalizeReservationLocale(
		resolveGuestLocale(
			subject.locale,
			context.organization.locales,
			context.organization.defaultLocale,
		),
		context.organization.defaultLocale as ReservationEmailLocale,
	)
	const location = context.locations.find((l) => l.id === subject.locationId)
	const restaurantName = location?.name ?? context.organization.name
	const timeZone =
		subject.timeZone ||
		location?.timeZone ||
		(await locationTimeZone(db, subject.locationId))
	const base = siteBase(context, locale)
	const token = subject.token
	const manageUrl =
		base && token && subject.kind === 'reservation'
			? `${base}/reserve/manage#t=${token}`
			: null
	const statusUrl =
		base && token && subject.kind === 'waitlist'
			? `${base}/reserve/waitlist#t=${token}`
			: null
	const bookUrl = base
		? `${base}/reserve${subject.bookQuery ? `?${subject.bookQuery}` : ''}`
		: null
	const kind = row.kind as ToggleableMessageKind | PaymentEmailKind
	const payUrl =
		base && subject.payment && kind === 'fee_action_required'
			? `${base}/reserve/pay#f=${subject.payment.id}&t=${deriveFeePayToken(orgId, subject.payment.id)}`
			: null

	if (row.channel === 'sms') {
		if (!subject.phone) throw new Error('no_destination')
		const url =
			subject.kind === 'reservation'
				? manageUrl
				: subject.kind === 'waitlist'
					? statusUrl
					: bookUrl
		await sendReservationSms({
			to: subject.phone,
			message: renderReservationSms({
				kind,
				locale,
				restaurantName,
				whenMs: subject.whenMs,
				timeZone,
				partySize: subject.partySize,
				url:
					kind === 'fee_action_required'
						? payUrl
						: url && kind !== 'cancellation_restaurant'
							? url
							: null,
				quotedWaitMin: subject.quotedWaitMin,
				amountMinor: subject.payment?.amountMinor ?? null,
				currency: subject.payment?.currency ?? null,
			}),
		})
		return
	}

	if (!subject.email) throw new Error('no_destination')
	const customNote = await customNoteFor(
		db,
		subject.locationId,
		row.kind,
		locale,
		context.organization.defaultLocale,
	)
	const address = location?.address?.formattedAddress ?? null
	const calendarUrl =
		subject.kind === 'reservation' && subject.whenMs && subject.endMs
			? buildCalendarUrl({
					title: restaurantName,
					startMs: subject.whenMs,
					endMs: subject.endMs,
					location: address,
				})
			: null
	const rendered = renderReservationEmail({
		kind,
		locale,
		theme: context.organization.emailTheme,
		restaurantName,
		address,
		phone: location?.phone ?? null,
		firstName: subject.firstName,
		whenMs: subject.whenMs,
		timeZone,
		partySize: subject.partySize,
		manageUrl,
		statusUrl,
		bookUrl,
		calendarUrl,
		quotedWaitMin: subject.quotedWaitMin,
		payUrl,
		amountMinor: subject.payment?.amountMinor ?? null,
		currency: subject.payment?.currency ?? null,
		customNote,
	})
	const result = await sendTenantEmail({
		to: subject.email,
		subject: rendered.subject,
		html: rendered.html,
		text: rendered.text,
		capture: { orgId, messageKind: row.kind, messageId: row.id },
	})
	if (result.status === 'error') {
		throw new Error('email_failed')
	}
}

async function recordBulkFailure(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
	now: number,
) {
	const recent = await db
		.select({ id: rsvMessages.id })
		.from(rsvMessages)
		.where(
			and(
				eq(rsvMessages.locationId, locationId),
				eq(rsvMessages.status, 'failed'),
				gte(rsvMessages.nextAttemptAt, now - BULK_FAILURE_WINDOW_MS),
			),
		)
	if (recent.length < BULK_FAILURE_THRESHOLD) return
	const bucket = Math.floor(now / BULK_FAILURE_WINDOW_MS)
	await enqueueManagerAlert(db, {
		orgId,
		kind: 'message_failed_bulk',
		locationId,
		count: recent.length,
		dedupeKey: `alert:message_failed_bulk:${locationId}:${bucket}`,
		now,
	})
}

async function setStatus(
	db: TenantDatabase,
	id: string,
	status: MessageRow['status'],
	extra: Partial<MessageRow> = {},
) {
	await db
		.update(rsvMessages)
		.set({ status, ...extra })
		.where(eq(rsvMessages.id, id))
}

async function processRow(options: {
	db: TenantDatabase
	orgId: string
	row: MessageRow
	now: number
	context: ReservationsContext | null
}): Promise<Outcome | null> {
	const { db, orgId, row, now, context } = options

	const claimed = await db
		.update(rsvMessages)
		.set({ status: 'sending', nextAttemptAt: now + CLAIM_LEASE_MS })
		.where(
			and(
				eq(rsvMessages.id, row.id),
				or(
					eq(rsvMessages.status, 'pending'),
					and(
						eq(rsvMessages.status, 'sending'),
						lte(rsvMessages.nextAttemptAt, now),
					),
				),
			),
		)
		.returning({ id: rsvMessages.id })
	if (claimed.length === 0) return null

	const hold = async () => {
		await setStatus(db, row.id, 'pending', { nextAttemptAt: now + HOLD_MS })
		return 'held' as const
	}

	if (!context || !context.features.enabled) return hold()
	if (WAITLIST_FLAG_KINDS.has(row.kind) && !context.features.waitlist) {
		return hold()
	}

	const switchOn =
		row.channel === 'sms'
			? isReservationsSmsEnabled()
			: isReservationsEmailEnabled()
	if (!switchOn) {
		await setStatus(db, row.id, 'dropped', { lastErrorCode: 'switch_off' })
		return 'dropped'
	}

	const resolved = await resolveSubject(db, orgId, row, now)
	if (!resolved.ok) {
		await setStatus(db, row.id, resolved.outcome, {
			lastErrorCode: resolved.code,
		})
		return resolved.outcome
	}
	const { subject } = resolved

	if (row.channel === 'sms') {
		let region: 'us' | 'ksa' = 'us'
		try {
			region = getNodeRegion()
		} catch {
			region = 'us'
		}
		if (region !== 'us' || !subject.smsAllowed || !subject.phone) {
			await setStatus(db, row.id, 'suppressed', {
				lastErrorCode: region !== 'us' ? 'sms_not_allowed' : 'no_sms_consent',
			})
			return 'suppressed'
		}
	} else if (!subject.email) {
		await setStatus(db, row.id, 'suppressed', {
			lastErrorCode: 'no_destination',
		})
		return 'suppressed'
	}

	try {
		await sendOne({ db, orgId, context, row, subject, now })
		await setStatus(db, row.id, 'sent', {
			sentAt: now,
			attempts: row.attempts + 1,
			lastErrorCode: null,
		})
		return 'sent'
	} catch (error) {
		const attempts = row.attempts + 1
		const code =
			error instanceof Error && /^[a-z_]{1,40}$/.test(error.message)
				? error.message
				: 'send_failed'
		const delay = RETRY_BACKOFF_MIN[attempts - 1]
		if (delay === undefined) {
			await setStatus(db, row.id, 'failed', {
				attempts,
				lastErrorCode: code,
				nextAttemptAt: now,
			})
			await recordBulkFailure(db, orgId, subject.locationId, now)
			return 'failed'
		}
		await setStatus(db, row.id, 'pending', {
			attempts,
			lastErrorCode: code,
			nextAttemptAt: now + delay * 60_000,
		})
		return 'retried'
	}
}

async function deliverRows(
	db: TenantDatabase,
	orgId: string,
	rows: MessageRow[],
	now: number,
): Promise<DeliveryTotals> {
	const totals = emptyDeliveryTotals()
	if (rows.length === 0) return totals
	const context = await getReservationsContext(orgId)
	for (const row of rows) {
		const outcome = await processRow({ db, orgId, row, now, context })
		if (outcome) totals[outcome]++
	}
	return totals
}

const DUE = (now: number) =>
	and(
		or(eq(rsvMessages.status, 'pending'), eq(rsvMessages.status, 'sending')),
		lte(rsvMessages.sendAt, now),
		lte(rsvMessages.nextAttemptAt, now),
	)

/** Tick entry: the next due rows, oldest first, bounded per pass. */
export async function deliverDueMessages(
	orgId: string,
	options: { db?: TenantDatabase; now?: number; limit?: number } = {},
): Promise<DeliveryTotals> {
	const db = options.db ?? (await getTenantDb(orgId))
	const now = options.now ?? Date.now()
	const rows = await db
		.select()
		.from(rsvMessages)
		.where(DUE(now))
		.orderBy(asc(rsvMessages.sendAt))
		.limit(options.limit ?? DELIVER_BATCH_LIMIT)
	return deliverRows(db, orgId, rows, now)
}

/** Right after a write commits: the rows it queued, if they are due. */
export async function deliverMessagesByIds(
	orgId: string,
	ids: readonly string[],
	options: { db?: TenantDatabase; now?: number } = {},
): Promise<DeliveryTotals> {
	if (ids.length === 0) return emptyDeliveryTotals()
	const db = options.db ?? (await getTenantDb(orgId))
	const now = options.now ?? Date.now()
	const rows = await queryInChunks([...ids], (chunk) =>
		db
			.select()
			.from(rsvMessages)
			.where(and(inArray(rsvMessages.id, chunk), DUE(now))),
	)
	return deliverRows(db, orgId, rows, now)
}

/** Whether any message is still waiting, and when the earliest is due. */
export async function nextMessageDueAt(
	db: TenantDatabase,
): Promise<number | null> {
	// A row is due at the later of its send and retry times, so the earliest
	// due row is not necessarily the one with the oldest `send_at`: a retrying
	// message must not hide one that comes due sooner.
	const row = await db
		.select({
			at: sql<
				number | null
			>`min(max(${rsvMessages.nextAttemptAt}, ${rsvMessages.sendAt}))`,
		})
		.from(rsvMessages)
		.where(eq(rsvMessages.status, 'pending'))
		.get()
	return typeof row?.at === 'number' ? row.at : null
}
