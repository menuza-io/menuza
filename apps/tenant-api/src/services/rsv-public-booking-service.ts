import { randomBytes, randomUUID } from 'node:crypto'
import {
	daysBetween,
	currentBusinessDate,
	isValidNormalizedPhone,
	normalizeGuestPhone,
	type AvailableSlot,
	type ReservationsContext,
} from '@repo/reservations'
import {
	getTenantDb,
	rsvGuests,
	rsvHolds,
	rsvLocationSettings,
	rsvPolicies,
	rsvReservationEvents,
	rsvReservations,
	rsvTags,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, desc, eq, inArray, gt, sql } from 'drizzle-orm'
import { HttpError } from '../lib/http.ts'
import { withReservationWrite } from '../lib/reservations-write.ts'
import { queueReservationJourney } from '../restaurant/reservations-journeys.ts'
import { recordReservationMarketingConsent } from './rsv-marketing-consent.ts'
import { isLateCancellation } from './rsv-late-cancel.ts'
import { enqueueReservationMessage } from './rsv-message-queue.ts'
import { markNotifyRequestsBooked } from './rsv-notify-service.ts'
import { handleCancellationPayments } from './rsv-payment-refunds.ts'
import {
	insertBookingPaymentRow,
	paymentHoldMinutes,
	planBookingPayment,
} from './rsv-payment-booking.ts'
import { enqueueManagerAlert } from './rsv-outbox.ts'
import {
	buildAlternatives,
	alternativesWindow,
	channelFor,
	deactivateOccupancies,
	insertOccupancyRows,
	slotUnavailable,
	type PublicSlotRequest,
} from './rsv-hold-service.ts'
import {
	bookingContactData,
	loadBookingContacts,
} from './rsv-booking-contact.ts'
import { type DbOrTx } from './rsv-guest-service.ts'
import {
	loadManageExperience,
	matchExperienceSeating,
} from './rsv-experience-engine.ts'
import {
	loadPublicEngineState,
	pickI18n,
	searchPublicDay,
	type PublicEngineState,
} from './rsv-public-engine.ts'

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 8 Crockford base32 characters (no I, L, O, U). 256 is a multiple of 32, so the modulo is unbiased. */
export function generatePublicConfirmationCode(): string {
	const bytes = randomBytes(8)
	let out = ''
	for (const byte of bytes) out += CROCKFORD_ALPHABET[byte % 32]
	return out
}

async function uniqueConfirmationCode(tx: DbOrTx): Promise<string> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const code = generatePublicConfirmationCode()
		const taken = await tx
			.select({ id: rsvReservations.id })
			.from(rsvReservations)
			.where(eq(rsvReservations.confirmationCode, code))
			.get()
		if (!taken) return code
	}
	throw new Error('could not allocate a confirmation code')
}

const ACTIVE_FUTURE_STATUSES = [
	'pending_payment',
	'pending_approval',
	'booked',
	'confirmed',
] as const

export function apiStatus(status: string): string {
	return status === 'pending_approval' ? 'requested' : status
}

function isoOrNull(ms: number | null | undefined): string | null {
	return ms === null || ms === undefined ? null : new Date(ms).toISOString()
}

function invalidField(path: string): HttpError {
	return new HttpError(400, 'invalid', undefined, {
		issues: [{ path, code: 'invalid' }],
	})
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

type LocationFacts = ReservationsContext['locations'][number]

export function findContextLocation(
	ctx: ReservationsContext,
	locationId: string,
): LocationFacts | null {
	return ctx.locations.find((l) => l.id === locationId) ?? null
}

export type PublicReservationSummary = ReturnType<typeof summarizeReservation>

export function summarizeReservation(
	row: typeof rsvReservations.$inferSelect,
	ctx: ReservationsContext,
) {
	const location = findContextLocation(ctx, row.locationId)
	return {
		id: row.id,
		confirmationCode: row.confirmationCode,
		status: apiStatus(row.status),
		channel: row.channel,
		locationId: row.locationId,
		locationName: location?.name ?? null,
		date: row.businessDate,
		localMin: row.localStartMin,
		time: `${String(Math.floor(row.localStartMin / 60) % 24).padStart(2, '0')}:${String(row.localStartMin % 60).padStart(2, '0')}`,
		startAt: new Date(row.startAt).toISOString(),
		endAt: new Date(row.endAt).toISOString(),
		partySize: row.partySize,
		timeZone: row.timeZone,
	}
}

function maskPhone(phone: string | null): string | null {
	if (!phone) return null
	const digits = phone.replace(/\D/g, '')
	return digits.length >= 4
		? `\u2022\u2022\u2022\u2022 ${digits.slice(-4)}`
		: null
}

function maskEmail(email: string | null): string | null {
	if (!email) return null
	const [local = '', domain = ''] = email.split('@')
	const [host = '', ...rest] = domain.split('.')
	if (!local || !host) return null
	return `${local[0]}***@${host[0]}***${rest.length ? `.${rest.join('.')}` : ''}`
}

export function cutoffState(
	row: Pick<typeof rsvReservations.$inferSelect, 'startAt' | 'status'>,
	cutoffMin: number,
	now: number,
) {
	const deadline = row.startAt - cutoffMin * 60_000
	const open = now < deadline
	const status = row.status
	return {
		deadline,
		open,
		canCancel:
			open && (ACTIVE_FUTURE_STATUSES as readonly string[]).includes(status),
		canModify: open && (status === 'booked' || status === 'confirmed'),
	}
}

export async function buildManageView(
	db: DbOrTx,
	ctx: ReservationsContext,
	row: typeof rsvReservations.$inferSelect,
	now: number,
) {
	const [guest, settings, occasion, contacts] = await Promise.all([
		db.select().from(rsvGuests).where(eq(rsvGuests.id, row.guestId)).get(),
		db
			.select()
			.from(rsvLocationSettings)
			.where(eq(rsvLocationSettings.locationId, row.locationId))
			.get(),
		row.occasionTagId
			? db.select().from(rsvTags).where(eq(rsvTags.id, row.occasionTagId)).get()
			: Promise.resolve(undefined),
		loadBookingContacts(db, [row.id]),
	])
	// What the booker typed for this booking, never the profile's name or email.
	const bookingContact = contacts.get(row.id)
	const firstName = bookingContact
		? bookingContact.firstName
		: (guest?.firstName ?? null)
	const contactEmail = bookingContact
		? bookingContact.email
		: (guest?.emailNorm ?? null)
	const policyId =
		(row.policySnapshot as { policyId?: string } | null)?.policyId ??
		settings?.defaultPolicyId ??
		null
	const policy = policyId
		? await db
				.select()
				.from(rsvPolicies)
				.where(eq(rsvPolicies.id, policyId))
				.get()
		: undefined
	const cutoff = cutoffState(row, settings?.guestModifyCutoffMin ?? 120, now)
	const location = findContextLocation(ctx, row.locationId)
	const summary = summarizeReservation(row, ctx)
	const experience = row.experienceId
		? await loadManageExperience(db, row.experienceId, row.guestLocale)
		: null
	return {
		now: new Date(now).toISOString(),
		reservation: {
			...summary,
			experience,
			firstName,
			occasion: occasion
				? {
						id: occasion.id,
						name:
							pickI18n(occasion.nameI18n, row.guestLocale, false) ??
							occasion.name,
					}
				: null,
			requests: row.guestRequests,
			dietary: row.dietaryNotes,
			runningLateMin: row.runningLateMin,
			smsOptIn: row.smsOptIn,
			location: {
				id: row.locationId,
				name: location?.name ?? null,
				address: location?.address?.formattedAddress ?? null,
				phone: location?.phone ?? settings?.contactPhone ?? null,
				timeZone: row.timeZone,
			},
		},
		status: summary.status,
		firstName,
		contact: {
			phone: maskPhone(guest?.phoneE164 ?? null),
			email: maskEmail(contactEmail),
		},
		policy:
			policy && policy.kind !== 'none'
				? {
						kind: policy.kind,
						terms: pickI18n(policy.termsI18n, row.guestLocale),
						freeCancelUntilMin: policy.freeCancelUntilMin,
						currency: policy.currency,
					}
				: null,
		paymentStatus: row.paymentStatus,
		// A seating of an experience cannot be moved to a regular slot by the guest.
		canModify: cutoff.canModify && !row.experienceId,
		canCancel: cutoff.canCancel,
		cancelDeadline: isoOrNull(cutoff.deadline),
	}
}

// ---------------------------------------------------------------------------
// Guests and per-phone limits
// ---------------------------------------------------------------------------

export type PublicGuestInput = {
	firstName: string
	lastName: string
	phone: string
	email?: string | null
	locale: string
}

export function normalizePublicPhone(raw: string): string | null {
	const normalized = normalizeGuestPhone(raw)
	return isValidNormalizedPhone(normalized) ? normalized : null
}

/**
 * Public bookings never rewrite an existing guest profile: anyone can type
 * someone else's phone number. Name, email and phone of a matched profile stay
 * as they are (the contact typed for this booking is kept on the booking's
 * first event), and the profile is linked to a signed-in customer only when the
 * customer's verified phone is the guest's phone.
 */
async function resolvePublicGuest(
	tx: DbOrTx,
	input: PublicGuestInput,
	options: {
		customerId: string | null
		customerPhone?: string | null
		marketing: boolean
		now: number
	},
): Promise<typeof rsvGuests.$inferSelect> {
	const phone = normalizePublicPhone(input.phone)
	if (!phone) throw invalidField('guest.phone')
	const email = input.email?.trim().toLowerCase() || null

	let guest =
		(options.customerId
			? await tx
					.select()
					.from(rsvGuests)
					.where(eq(rsvGuests.customerId, options.customerId))
					.get()
			: undefined) ?? undefined
	if (!guest) {
		guest = await tx
			.select()
			.from(rsvGuests)
			.where(
				and(
					eq(rsvGuests.phoneE164, phone),
					sql`${rsvGuests.mergedIntoId} IS NULL`,
					sql`${rsvGuests.erasedAt} IS NULL`,
				),
			)
			.get()
	}

	if (guest) {
		const verifiedPhone = options.customerPhone
			? normalizePublicPhone(options.customerPhone)
			: null
		const patch: Partial<typeof rsvGuests.$inferInsert> = {}
		if (
			options.customerId &&
			!guest.customerId &&
			verifiedPhone !== null &&
			verifiedPhone === guest.phoneE164
		) {
			const owner = await tx
				.select({ id: rsvGuests.id })
				.from(rsvGuests)
				.where(eq(rsvGuests.customerId, options.customerId))
				.get()
			if (!owner) patch.customerId = options.customerId
		}
		// Marketing consent only counts for the address the profile holds.
		if (options.marketing && email && guest.emailNorm === email) {
			patch.marketingEmailConsentAt = options.now
			patch.consentSource = 'online_reservation'
		}
		if (Object.keys(patch).length > 0) {
			await tx
				.update(rsvGuests)
				.set({ ...patch, updatedAt: options.now })
				.where(eq(rsvGuests.id, guest.id))
			guest = (await tx
				.select()
				.from(rsvGuests)
				.where(eq(rsvGuests.id, guest.id))
				.get())!
		}
		return guest
	}

	const consent =
		options.marketing && email
			? {
					marketingEmailConsentAt: options.now,
					consentSource: 'online_reservation',
				}
			: {}
	const id = `gst_${randomUUID()}`
	await tx.insert(rsvGuests).values({
		id,
		customerId: options.customerId,
		firstName: input.firstName.trim(),
		lastName: input.lastName.trim(),
		phoneE164: phone,
		emailNorm: email,
		locale: input.locale || 'en',
		...consent,
		createdAt: options.now,
		updatedAt: options.now,
	})
	return (await tx.select().from(rsvGuests).where(eq(rsvGuests.id, id)).get())!
}

async function enforcePhoneLimits(
	tx: DbOrTx,
	guestId: string,
	settings: { maxActivePerPhone: number; blockSamePhoneOverlap: boolean },
	window: { startAt: number; endAt: number },
	now: number,
	excludeReservationId?: string,
) {
	const rows = await tx
		.select({
			id: rsvReservations.id,
			startAt: rsvReservations.startAt,
			endAt: rsvReservations.endAt,
		})
		.from(rsvReservations)
		.where(
			and(
				eq(rsvReservations.guestId, guestId),
				inArray(rsvReservations.status, [...ACTIVE_FUTURE_STATUSES]),
				gt(rsvReservations.endAt, now),
			),
		)
		.all()
	const others = rows.filter((r) => r.id !== excludeReservationId)
	if (others.length >= settings.maxActivePerPhone) {
		throw new HttpError(429, 'rate_limited', undefined, {
			reason: 'phone_active_limit',
		})
	}
	if (
		settings.blockSamePhoneOverlap &&
		others.some((r) => r.startAt < window.endAt && r.endAt > window.startAt)
	) {
		throw new HttpError(409, 'phone_overlap')
	}
}

async function validateOccasionTag(
	tx: DbOrTx,
	tagId: string | null | undefined,
) {
	if (!tagId) return null
	const tag = await tx
		.select({
			id: rsvTags.id,
			selectable: rsvTags.guestSelectable,
			archivedAt: rsvTags.archivedAt,
		})
		.from(rsvTags)
		.where(eq(rsvTags.id, tagId))
		.get()
	if (!tag || !tag.selectable || tag.archivedAt !== null) {
		throw invalidField('occasionTagId')
	}
	return tag.id
}

// ---------------------------------------------------------------------------
// Booking from a hold
// ---------------------------------------------------------------------------

export type PublicBookingInput = {
	guest: PublicGuestInput
	occasionTagId?: string | null
	requests?: string | null
	dietary?: string | null
	areaPref?: string | null
	smsOptIn: boolean
	marketing: boolean
	policyAccepted?: boolean
}

function holdExpired(): HttpError {
	return new HttpError(410, 'hold_expired')
}

export async function readHoldForBooking(orgId: string, tokenHash: string) {
	const db = await getTenantDb(orgId)
	return (
		(await db
			.select()
			.from(rsvHolds)
			.where(eq(rsvHolds.tokenHash, tokenHash))
			.get()) ?? null
	)
}

/** Converts a live hold into a booked reservation exactly once; the stored idempotency value is the id only. */
export async function bookFromHold(params: {
	orgId: string
	holdTokenHash: string
	input: PublicBookingInput
	client: string
	channel: 'online' | 'native'
	/** Idempotency scope; a phone-agent booking uses `voice_book`. */
	idempotencyScope?: string
	customerId: string | null
	/** The signed-in customer's verified phone, when there is one. */
	customerPhone?: string | null
	ipHash: string
	idempotencyKey: string
	requestHash: string
	/** Organization facts: with payments on, a money policy parks the booking in `pending_payment`. */
	context?: ReservationsContext | null
	now?: number
}): Promise<{ reservationId: string }> {
	const now = params.now ?? Date.now()
	const pre = await readHoldForBooking(params.orgId, params.holdTokenHash)
	if (!pre) throw holdExpired()
	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: pre.locationId,
			dates: pre.businessDate,
			now,
			scope: params.idempotencyScope ?? 'POST /reservations',
			idempotencyKey: params.idempotencyKey,
			requestHash: params.requestHash,
		},
		async (tx, helpers) => {
			const hold = await tx
				.select()
				.from(rsvHolds)
				.where(eq(rsvHolds.id, pre.id))
				.get()
			if (!hold || hold.status !== 'active' || hold.expiresAt <= now) {
				throw holdExpired()
			}

			// Booking-window rules were checked when the hold was taken.
			const rulesAt = Math.min(now, hold.createdAt)
			const window = alternativesWindow(hold.businessDate)
			const state = await loadPublicEngineState(tx, {
				locationId: hold.locationId,
				...window,
				now: rulesAt,
				excludeHoldIds: new Set([hold.id]),
			})
			if (!state) throw new HttpError(404, 'not_found')

			// An experience hold is re-checked against its seating, caps and areas.
			const experienceMatch = hold.experienceId
				? await matchExperienceSeating(tx, state, {
						locationId: hold.locationId,
						experienceId: hold.experienceId,
						businessDate: hold.businessDate,
						localMin: hold.localStartMin,
						partySize: hold.partySize,
						now: rulesAt,
						channel: channelFor(hold.source),
						excludeHoldIds: new Set([hold.id]),
					})
				: null
			const result = searchPublicDay(state, {
				businessDate: hold.businessDate,
				partySize: hold.partySize,
				now: rulesAt,
				preferredSlotMin: hold.localStartMin,
				channel: channelFor(hold.source),
			})
			const match =
				experienceMatch ??
				result.slots.find(
					(s: AvailableSlot) =>
						s.slotMin === hold.localStartMin &&
						(!hold.serviceId || s.serviceId === hold.serviceId),
				)
			if (!match) {
				throw slotUnavailable(
					buildAlternatives(state, result, {
						date: hold.businessDate,
						localMin: hold.localStartMin,
						partySize: hold.partySize,
						now: rulesAt,
					}),
				)
			}

			const occasionTagId = await validateOccasionTag(
				tx,
				params.input.occasionTagId,
			)
			const guest = await resolvePublicGuest(tx, params.input.guest, {
				customerId: params.customerId,
				customerPhone: params.customerPhone,
				marketing: params.input.marketing,
				now,
			})
			await enforcePhoneLimits(
				tx,
				guest.id,
				state.settings,
				{ startAt: hold.startAt, endAt: hold.endAt },
				now,
			)
			if (params.input.marketing) {
				await recordReservationMarketingConsent(tx, {
					guest,
					email: params.input.guest.email?.trim().toLowerCase() || null,
					channels: ['email'],
					now,
				})
			}

			const paymentPlan = await planBookingPayment(tx, {
				context: params.context,
				locationId: hold.locationId,
				serviceId: match.serviceId,
				experienceId: hold.experienceId,
				partySize: hold.partySize,
				locale: params.input.guest.locale || 'en',
			})
			if (paymentPlan.required && !params.input.policyAccepted) {
				throw new HttpError(400, 'policy_required')
			}
			const paymentExpiresAt = paymentPlan.required
				? now + (await paymentHoldMinutes(tx, hold.locationId)) * 60_000
				: null
			const initialStatus = paymentPlan.required ? 'pending_payment' : 'booked'

			// A hold a phone-agent call took books as that call's reservation.
			const channel =
				hold.source === 'voice_agent' ? 'voice_agent' : params.channel
			const reservationId = `rsv_${randomUUID()}`
			await deactivateOccupancies(tx, { holdId: hold.id })
			await tx.insert(rsvReservations).values({
				id: reservationId,
				locationId: hold.locationId,
				guestId: guest.id,
				customerId: params.customerId,
				confirmationCode: await uniqueConfirmationCode(tx),
				businessDate: hold.businessDate,
				localStartMin: hold.localStartMin,
				timeZone: state.timeZone,
				startAt: hold.startAt,
				endAt: hold.endAt,
				durationMin: match.turnMin,
				serviceId: match.serviceId,
				experienceId: hold.experienceId,
				partySize: hold.partySize,
				status: initialStatus,
				channel,
				client: params.client,
				voiceCallId: hold.voiceCallId,
				// Automatic repair must never move a table-using experience booking.
				assignment:
					hold.experienceId && match.tableIds.length > 0 ? 'locked' : 'soft',
				comboId: match.combinationId,
				occasionTagId,
				guestRequests: params.input.requests?.trim() || null,
				dietaryNotes: params.input.dietary?.trim() || null,
				paymentStatus: paymentPlan.required ? 'pending' : 'none',
				paymentExpiresAt,
				policySnapshot: paymentPlan.required
					? (paymentPlan.snapshot as unknown as Record<string, unknown>)
					: null,
				policyTextHash: paymentPlan.required ? paymentPlan.termsHash : null,
				policyAcceptedAt: params.input.policyAccepted ? now : null,
				holdId: hold.id,
				smsOptIn: params.input.smsOptIn,
				guestLocale: params.input.guest.locale || 'en',
				createdByKind: 'guest',
				ipHash: params.ipHash,
				createdAt: now,
				updatedAt: now,
			})
			await insertOccupancyRows(tx, {
				locationId: hold.locationId,
				kind: 'reservation',
				ownerId: reservationId,
				tableIds: match.tableIds,
				startAt: hold.startAt,
				endAt: hold.endAt,
				resetBufferMin: (id) => state.tableById.get(id)?.resetBufferMin ?? 0,
				now,
			})
			await tx
				.update(rsvHolds)
				.set({
					status: 'converted',
					reservationId,
					// The unpaid booking keeps its capacity for the payment window.
					...(paymentExpiresAt !== null
						? { extendedForPayment: true, expiresAt: paymentExpiresAt }
						: {}),
				})
				.where(eq(rsvHolds.id, hold.id))
			if (paymentPlan.required) {
				await insertBookingPaymentRow(tx, {
					reservationId,
					locationId: hold.locationId,
					plan: paymentPlan,
					now,
				})
			}
			await tx.insert(rsvReservationEvents).values({
				id: `rev_${randomUUID()}`,
				reservationId,
				at: now,
				actorKind: 'guest',
				type: 'created',
				fromStatus: null,
				toStatus: initialStatus,
				data: {
					channel,
					partySize: hold.partySize,
					...bookingContactData(params.input.guest),
				},
			})
			// An unpaid booking is confirmed by `payment_received` (or the
			// guarantee confirmation) once the payment lands.
			if (!paymentPlan.required) {
				await enqueueReservationMessage(
					tx,
					{ orgId: params.orgId, now, afterCommit: helpers.afterCommit },
					{ reservationId, kind: 'confirmation' },
				)
			}
			await markNotifyRequestsBooked(tx, {
				locationId: hold.locationId,
				businessDate: hold.businessDate,
				guestId: guest.id,
				now,
			})
			// An unpaid booking fires `reservation_booked` once payment lands.
			if (!paymentPlan.required) {
				queueReservationJourney(helpers.afterCommit, {
					orgId: params.orgId,
					reservationId,
					trigger: 'reservation_booked',
				})
			}
			return { reservationId }
		},
	)
}

// ---------------------------------------------------------------------------
// Large-party requests
// ---------------------------------------------------------------------------

type TableRow =
	PublicEngineState['tableById'] extends Map<string, infer T> ? T : never

/**
 * Greedy fallback for requests that no single table or combination fits: the
 * biggest free tables until the party is seated. A host would do the same by
 * hand, and it keeps the capacity out of public availability while pending.
 */
export function pickTablesForLargeParty(
	state: PublicEngineState,
	params: {
		businessDate: string
		partySize: number
		startAt: number
		endAt: number
	},
): string[] | null {
	const busy = new Set<string>()
	for (const occ of state.occupanciesFor(params.businessDate)) {
		if (
			occ.kind === 'hold' &&
			occ.expiresAt !== undefined &&
			occ.expiresAt <= Date.now()
		) {
			continue
		}
		for (const tableId of occ.tableIds ?? []) {
			const reset = (state.tableById.get(tableId)?.resetBufferMin ?? 0) * 60_000
			if (
				occ.startAt < params.endAt + reset &&
				occ.endAt + reset > params.startAt
			) {
				busy.add(tableId)
			}
		}
	}
	const candidates = [...state.tableById.values()]
		.filter(
			(t: TableRow) =>
				t.archivedAt === null && t.onlineBookable && !busy.has(t.id),
		)
		.sort(
			(a: TableRow, b: TableRow) =>
				b.maxCovers - a.maxCovers || a.priority - b.priority,
		)
	const chosen: string[] = []
	let seats = 0
	for (const table of candidates) {
		if (seats >= params.partySize) break
		chosen.push(table.id)
		seats += table.maxCovers
	}
	return seats >= params.partySize ? chosen : null
}

/** Tables a pending request holds: the engine's best fit first, then the greedy set. */
export function planRequestTables(
	state: PublicEngineState,
	params: {
		businessDate: string
		localMin: number
		partySize: number
		serviceId?: string | null
		now: number
		startAt?: number
		endAt?: number
	},
): string[] {
	const result = searchPublicDay(state, {
		businessDate: params.businessDate,
		partySize: params.partySize,
		now: params.now,
		channel: 'host',
	})
	const match = result.slots.find(
		(s) =>
			s.slotMin === params.localMin &&
			(!params.serviceId || s.serviceId === params.serviceId),
	)
	if (match && match.tableIds.length > 0) return [...match.tableIds]
	if (params.startAt === undefined || params.endAt === undefined) return []
	return (
		pickTablesForLargeParty(state, {
			businessDate: params.businessDate,
			partySize: params.partySize,
			startAt: params.startAt,
			endAt: params.endAt,
		}) ?? []
	)
}

export type PublicRequestInput = PublicBookingInput & {
	slot: PublicSlotRequest
}

export async function createLargePartyRequest(params: {
	orgId: string
	locationId: string
	input: PublicRequestInput
	client: string
	channel: 'online' | 'native'
	customerId: string | null
	/** The signed-in customer's verified phone, when there is one. */
	customerPhone?: string | null
	ipHash: string
	idempotencyKey: string
	requestHash: string
	now?: number
}): Promise<{ reservationId: string }> {
	const now = params.now ?? Date.now()
	const { slot } = params.input
	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: params.locationId,
			dates: slot.date,
			now,
			scope: 'POST /reservations/requests',
			idempotencyKey: params.idempotencyKey,
			requestHash: params.requestHash,
		},
		async (tx, helpers) => {
			const window = alternativesWindow(slot.date)
			const state = await loadPublicEngineState(tx, {
				locationId: params.locationId,
				...window,
				now,
			})
			if (!state) throw new HttpError(404, 'not_found')
			const { settings } = state
			if (!settings.enabled || !settings.onlineEnabled) {
				throw new HttpError(404, 'not_found')
			}
			if (settings.largePartyMode !== 'request') {
				throw new HttpError(409, 'requests_closed')
			}
			if (
				slot.partySize <= settings.onlinePartyMax ||
				slot.partySize > settings.partyMax
			) {
				throw invalidField('slot.partySize')
			}

			const today = currentBusinessDate(
				now,
				state.timeZone,
				settings.dayStartMin,
			)
			if (daysBetween(today, slot.date) > settings.horizonDays) {
				throw slotUnavailable()
			}

			// The time must be a real seating on an open day; capacity is allowed to be short.
			const structural = loadStructuralSlot(state, slot, now)
			if (!structural) throw slotUnavailable()

			const occasionTagId = await validateOccasionTag(
				tx,
				params.input.occasionTagId,
			)
			const guest = await resolvePublicGuest(tx, params.input.guest, {
				customerId: params.customerId,
				customerPhone: params.customerPhone,
				marketing: params.input.marketing,
				now,
			})
			await enforcePhoneLimits(
				tx,
				guest.id,
				settings,
				{ startAt: structural.startAt, endAt: structural.endAt },
				now,
			)

			const endAt = structural.startAt + structural.turnMin * 60_000
			const tableIds = settings.requestHoldsCapacity
				? planRequestTables(state, {
						businessDate: slot.date,
						localMin: structural.slotMin,
						partySize: slot.partySize,
						serviceId: structural.serviceId,
						now,
						startAt: structural.startAt,
						endAt,
					})
				: []

			const reservationId = `rsv_${randomUUID()}`
			await tx.insert(rsvReservations).values({
				id: reservationId,
				locationId: params.locationId,
				guestId: guest.id,
				customerId: params.customerId,
				confirmationCode: await uniqueConfirmationCode(tx),
				businessDate: slot.date,
				localStartMin: structural.slotMin,
				timeZone: state.timeZone,
				startAt: structural.startAt,
				endAt,
				durationMin: structural.turnMin,
				serviceId: structural.serviceId,
				partySize: slot.partySize,
				status: 'pending_approval',
				channel: params.channel,
				client: params.client,
				assignment: 'soft',
				occasionTagId,
				guestRequests: params.input.requests?.trim() || null,
				dietaryNotes: params.input.dietary?.trim() || null,
				paymentStatus: 'none',
				policyAcceptedAt: params.input.policyAccepted ? now : null,
				requestDeadlineAt: Math.min(
					now + settings.requestDeadlineHours * 3_600_000,
					structural.startAt,
				),
				smsOptIn: params.input.smsOptIn,
				guestLocale: params.input.guest.locale || 'en',
				createdByKind: 'guest',
				ipHash: params.ipHash,
				createdAt: now,
				updatedAt: now,
			})
			await insertOccupancyRows(tx, {
				locationId: params.locationId,
				kind: 'reservation',
				ownerId: reservationId,
				tableIds,
				startAt: structural.startAt,
				endAt,
				resetBufferMin: (id) => state.tableById.get(id)?.resetBufferMin ?? 0,
				now,
			})
			await tx.insert(rsvReservationEvents).values({
				id: `rev_${randomUUID()}`,
				reservationId,
				at: now,
				actorKind: 'guest',
				type: 'requested',
				fromStatus: null,
				toStatus: 'pending_approval',
				data: {
					partySize: slot.partySize,
					holdsCapacity: tableIds.length > 0,
					...bookingContactData(params.input.guest),
				},
			})
			await enqueueReservationMessage(
				tx,
				{ orgId: params.orgId, now, afterCommit: helpers.afterCommit },
				{ reservationId, kind: 'request_received' },
			)
			await enqueueManagerAlert(tx, {
				orgId: params.orgId,
				kind: 'large_party_request',
				locationId: params.locationId,
				dedupeKey: `large_party_request:${reservationId}`,
				now,
			})
			return { reservationId }
		},
	)
}

/** Slot that exists on an open day for a staff-like channel, ignoring what is already booked. */
function loadStructuralSlot(
	state: PublicEngineState,
	slot: PublicSlotRequest,
	now: number,
): AvailableSlot | null {
	const empty: PublicEngineState = { ...state, occupanciesFor: () => [] }
	const result = searchPublicDay(empty, {
		businessDate: slot.date,
		partySize: slot.partySize,
		now,
		channel: 'host',
	})
	return (
		result.slots.find(
			(s) =>
				s.slotMin === slot.localMin &&
				(!slot.serviceId || s.serviceId === slot.serviceId),
		) ?? null
	)
}

// ---------------------------------------------------------------------------
// Manage (capability token) operations
// ---------------------------------------------------------------------------

export async function loadReservationById(db: DbOrTx, id: string) {
	return (
		(await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, id))
			.get()) ?? null
	)
}

async function loadSettings(db: DbOrTx, locationId: string) {
	return (
		(await db
			.select()
			.from(rsvLocationSettings)
			.where(eq(rsvLocationSettings.locationId, locationId))
			.get()) ?? null
	)
}

function notManageable(code: string): HttpError {
	return new HttpError(409, code)
}

export async function guestCancelReservation(params: {
	orgId: string
	reservationId: string
	now?: number
}): Promise<{ reservationId: string }> {
	const now = params.now ?? Date.now()
	const db = await getTenantDb(params.orgId)
	const pre = await loadReservationById(db, params.reservationId)
	if (!pre) throw new HttpError(404, 'not_found')
	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: pre.locationId,
			dates: pre.businessDate,
			now,
		},
		async (tx, helpers) => {
			const current = await loadReservationById(tx, pre.id)
			if (!current) throw new HttpError(404, 'not_found')
			if (current.status === 'cancelled') return { reservationId: current.id }
			if (
				!(ACTIVE_FUTURE_STATUSES as readonly string[]).includes(current.status)
			) {
				throw notManageable('not_cancellable')
			}
			const settings = await loadSettings(tx, current.locationId)
			const cutoff = cutoffState(
				current,
				settings?.guestModifyCutoffMin ?? 120,
				now,
			)
			if (!cutoff.canCancel) throw new HttpError(409, 'cancel_closed')

			const late = await isLateCancellation(tx, current, now)
			await deactivateOccupancies(tx, { reservationId: current.id })
			await tx
				.update(rsvReservations)
				.set({
					status: 'cancelled',
					cancelledAt: now,
					cancelledBy: 'guest',
					lateCancel: late,
					version: current.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, current.id))
			await tx
				.update(rsvGuests)
				.set({
					cancels: sql`${rsvGuests.cancels} + 1`,
					...(late ? { lateCancels: sql`${rsvGuests.lateCancels} + 1` } : {}),
					updatedAt: now,
				})
				.where(eq(rsvGuests.id, current.guestId))
			await tx.insert(rsvReservationEvents).values({
				id: `rev_${randomUUID()}`,
				reservationId: current.id,
				at: now,
				actorKind: 'guest',
				type: 'cancelled',
				fromStatus: current.status,
				toStatus: 'cancelled',
				data: { cancelledBy: 'guest' },
			})
			await enqueueReservationMessage(
				tx,
				{ orgId: params.orgId, now, afterCommit: helpers.afterCommit },
				{ reservationId: current.id, kind: 'cancellation_guest' },
			)
			await handleCancellationPayments(tx, {
				orgId: params.orgId,
				reservation: current,
				cancelledBy: 'guest',
				late,
				now,
			})
			queueReservationJourney(helpers.afterCommit, {
				orgId: params.orgId,
				reservationId: current.id,
				trigger: 'reservation_cancelled',
			})
			return { reservationId: current.id }
		},
	)
}

export async function guestConfirmReservation(params: {
	orgId: string
	reservationId: string
	now?: number
}): Promise<{ reservationId: string }> {
	const now = params.now ?? Date.now()
	const db = await getTenantDb(params.orgId)
	const pre = await loadReservationById(db, params.reservationId)
	if (!pre) throw new HttpError(404, 'not_found')
	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: pre.locationId,
			dates: pre.businessDate,
			now,
		},
		async (tx) => {
			const current = await loadReservationById(tx, pre.id)
			if (!current) throw new HttpError(404, 'not_found')
			if (current.status === 'confirmed') return { reservationId: current.id }
			if (current.status !== 'booked') throw notManageable('not_confirmable')
			await tx
				.update(rsvReservations)
				.set({
					status: 'confirmed',
					version: current.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, current.id))
			await tx.insert(rsvReservationEvents).values({
				id: `rev_${randomUUID()}`,
				reservationId: current.id,
				at: now,
				actorKind: 'guest',
				type: 'confirmed',
				fromStatus: 'booked',
				toStatus: 'confirmed',
				data: { by: 'guest' },
			})
			return { reservationId: current.id }
		},
	)
}

export async function guestRunningLate(params: {
	orgId: string
	reservationId: string
	minutes: number
	now?: number
}): Promise<{ reservationId: string }> {
	const now = params.now ?? Date.now()
	const db = await getTenantDb(params.orgId)
	const pre = await loadReservationById(db, params.reservationId)
	if (!pre) throw new HttpError(404, 'not_found')
	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: pre.locationId,
			dates: pre.businessDate,
			now,
		},
		async (tx) => {
			const current = await loadReservationById(tx, pre.id)
			if (!current) throw new HttpError(404, 'not_found')
			if (current.status !== 'booked' && current.status !== 'confirmed') {
				throw notManageable('not_late_eligible')
			}
			await tx
				.update(rsvReservations)
				.set({
					runningLateMin: params.minutes,
					version: current.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, current.id))
			await tx.insert(rsvReservationEvents).values({
				id: `rev_${randomUUID()}`,
				reservationId: current.id,
				at: now,
				actorKind: 'guest',
				type: 'running_late',
				fromStatus: current.status,
				toStatus: current.status,
				data: { runningLateMin: params.minutes },
			})
			return { reservationId: current.id }
		},
	)
}

export async function guestModifyReservation(params: {
	orgId: string
	reservationId: string
	input: { date?: string; localMin: number; partySize?: number }
	now?: number
}): Promise<{ reservationId: string }> {
	const now = params.now ?? Date.now()
	const db = await getTenantDb(params.orgId)
	const pre = await loadReservationById(db, params.reservationId)
	if (!pre) throw new HttpError(404, 'not_found')
	const targetDate = params.input.date ?? pre.businessDate
	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: pre.locationId,
			dates: [pre.businessDate, targetDate],
			now,
		},
		async (tx, helpers) => {
			const current = await loadReservationById(tx, pre.id)
			if (!current) throw new HttpError(404, 'not_found')
			if (current.status !== 'booked' && current.status !== 'confirmed') {
				throw notManageable('not_modifiable')
			}
			// The regular search below cannot place a seating of an experience.
			if (current.experienceId) throw notManageable('not_modifiable')
			const settings = await loadSettings(tx, current.locationId)
			const cutoff = cutoffState(
				current,
				settings?.guestModifyCutoffMin ?? 120,
				now,
			)
			if (!cutoff.canModify) throw new HttpError(409, 'modify_closed')

			const partySize = params.input.partySize ?? current.partySize
			const window = alternativesWindow(targetDate)
			const state = await loadPublicEngineState(tx, {
				locationId: current.locationId,
				...window,
				now,
				excludeReservationIds: new Set([current.id]),
			})
			if (!state) throw new HttpError(404, 'not_found')
			const result = searchPublicDay(state, {
				businessDate: targetDate,
				partySize,
				now,
				preferredSlotMin: params.input.localMin,
				channel: current.channel === 'native' ? 'native' : 'online',
			})
			if (result.status === 'party_out_of_bounds') {
				throw new HttpError(400, 'party_size_invalid')
			}
			if (result.status === 'large_party')
				throw new HttpError(409, 'large_party')
			const match = result.slots.find(
				(s) =>
					s.slotMin === params.input.localMin &&
					(targetDate !== current.businessDate ||
						params.input.localMin !== current.localStartMin ||
						!current.serviceId ||
						s.serviceId === current.serviceId),
			)
			if (!match) {
				throw slotUnavailable(
					buildAlternatives(state, result, {
						date: targetDate,
						localMin: params.input.localMin,
						partySize,
						now,
					}),
				)
			}

			if (settings) {
				await enforcePhoneLimits(
					tx,
					current.guestId,
					settings,
					{
						startAt: match.startAt,
						endAt: match.startAt + match.turnMin * 60_000,
					},
					now,
					current.id,
				)
			}

			const endAt = match.startAt + match.turnMin * 60_000
			await deactivateOccupancies(tx, { reservationId: current.id })
			await tx
				.update(rsvReservations)
				.set({
					businessDate: targetDate,
					localStartMin: match.slotMin,
					startAt: match.startAt,
					endAt,
					durationMin: match.turnMin,
					serviceId: match.serviceId,
					partySize,
					comboId: match.combinationId,
					runningLateMin: null,
					scheduleVersion: current.scheduleVersion + 1,
					version: current.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, current.id))
			await insertOccupancyRows(tx, {
				locationId: current.locationId,
				kind: 'reservation',
				ownerId: current.id,
				tableIds: match.tableIds,
				startAt: match.startAt,
				endAt,
				resetBufferMin: (id) => state.tableById.get(id)?.resetBufferMin ?? 0,
				now,
			})
			await tx.insert(rsvReservationEvents).values({
				id: `rev_${randomUUID()}`,
				reservationId: current.id,
				at: now,
				actorKind: 'guest',
				type: 'modified',
				fromStatus: current.status,
				toStatus: current.status,
				data: {
					from: {
						date: current.businessDate,
						localMin: current.localStartMin,
						partySize: current.partySize,
					},
					to: { date: targetDate, localMin: match.slotMin, partySize },
				},
			})
			await enqueueReservationMessage(
				tx,
				{ orgId: params.orgId, now, afterCommit: helpers.afterCommit },
				{ reservationId: current.id, kind: 'modification' },
			)
			return { reservationId: current.id }
		},
	)
}

export async function listCustomerReservations(
	db: TenantDatabase,
	customerId: string,
	now: number,
) {
	const rows = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.customerId, customerId))
		.orderBy(desc(rsvReservations.startAt))
		.limit(200)
		.all()
	const upcoming = rows
		.filter(
			(r) =>
				r.endAt > now &&
				(ACTIVE_FUTURE_STATUSES as readonly string[]).includes(r.status),
		)
		.sort((a, b) => a.startAt - b.startAt)
	const past = rows.filter((r) => !upcoming.includes(r))
	return { upcoming, past }
}
