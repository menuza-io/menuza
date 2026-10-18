import { isUsOrCanadaNumber } from '@repo/phone-agent'
import { type ReservationsContext } from '@repo/reservations'
import { rsvHolds } from '@repo/tenant-db'
import { and, eq, gt } from 'drizzle-orm'
import { z } from 'zod'
import { HttpError } from '../lib/http.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import {
	hashHoldToken,
	isWellFormedHoldToken,
	newHoldToken,
} from '../lib/reservations-public-auth.ts'
import { hashIdempotencyPayload } from '../lib/reservations-write.ts'
import {
	createHold,
	releaseHoldByTokenHash,
} from '../services/rsv-hold-service.ts'
import {
	describeBookingPolicy,
	planBookingPayment,
} from '../services/rsv-payment-booking.ts'
import { bookFromHold } from '../services/rsv-public-booking-service.ts'
import {
	type BookableLocation,
	getPublicAvailability,
	listBookableLocations,
} from '../services/rsv-public-service.ts'
import {
	registerVoiceAction,
	registerVoiceLinkFragment,
	type VoiceActionContext,
	type VoiceActionResult,
} from '../services/voice-actions.ts'

/**
 * Reservation actions for the restaurant phone agent (US only). They call the
 * same engine and services as the public booking routes with the guest-channel
 * rules, and never return or look up guest data: caller ID is spoofable, so a
 * caller is never identified by their number.
 */

export const VOICE_ACTION_NAMES = {
	availability: 'reservations.availability',
	hold: 'reservations.hold',
	book: 'reservations.book',
} as const

/** Per-call caps (rows in `voice_call_actions` for one call and name). */
export const VOICE_ACTION_CAPS = {
	availability: 10,
	hold: 2,
	book: 1,
} as const

export const MAX_VOICE_SLOTS = 3
const RESERVE_PATH = '/reserve'

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const partySizeSchema = z.number().int().min(1).max(99)
const locationIdSchema = z.string().trim().min(1).max(128).optional()
const firstNameSchema = z.string().trim().min(1).max(60)

const slotSchema = z
	.union([
		z.object({ date: dateSchema, localTime: localTimeSchema }),
		z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/)
			.transform((value) => ({
				date: value.slice(0, 10),
				localTime: value.slice(11, 16),
			})),
	])
	.transform((value) => ({ date: value.date, localTime: value.localTime }))

const availabilitySchema = z.object({
	locationId: locationIdSchema,
	date: dateSchema,
	time: localTimeSchema.optional(),
	partySize: partySizeSchema,
})

const holdSchema = z.object({
	locationId: locationIdSchema,
	slot: slotSchema,
	partySize: partySizeSchema,
	firstName: firstNameSchema,
})

const bookSchema = z.object({
	locationId: locationIdSchema,
	slot: slotSchema,
	partySize: partySizeSchema,
	firstName: firstNameSchema,
	lastName: z.string().trim().max(60).optional(),
})

function toMinutes(localTime: string): number {
	const [h, m] = localTime.split(':').map(Number)
	return (h ?? 0) * 60 + (m ?? 0)
}

const fail = (
	reason: Extract<VoiceActionResult, { ok: false }>['reason'],
	explanation: string,
): VoiceActionResult => ({ ok: false, reason, explanation })

const NOT_ENABLED = fail(
	'not_enabled',
	"Booking tables by phone isn't turned on for this restaurant.",
)

type Resolved =
	| {
			ok: true
			context: ReservationsContext
			location: BookableLocation
	  }
	| { ok: false; result: VoiceActionResult }

/** Flags, region and location scope, shared by every reservation action. */
async function resolveBooking(
	ctx: VoiceActionContext,
	requestedLocationId: string | undefined,
): Promise<Resolved> {
	const context = await getReservationsContext(ctx.orgId)
	if (!context) {
		return {
			ok: false,
			result: fail('unavailable', "I can't check tables right now."),
		}
	}
	// The phone agent is US only, whatever the flags say.
	if (
		context.dataRegion !== 'us' ||
		!context.features.enabled ||
		!context.features.voice
	) {
		return { ok: false, result: NOT_ENABLED }
	}

	const bookable = await listBookableLocations(ctx.db, context)
	// The call's own location wins: a caller (or a confused model) can never
	// reach another location's tables by naming its id.
	const callScope = ctx.call.scopeId
	if (callScope && requestedLocationId && callScope !== requestedLocationId) {
		return {
			ok: false,
			result: fail('invalid', 'That is not the location for this call.'),
		}
	}
	const wanted =
		callScope ??
		requestedLocationId ??
		(bookable.length === 1 ? bookable[0]!.facts.id : null)
	if (!wanted) {
		return {
			ok: false,
			result: fail('invalid', 'Which location is the booking for?'),
		}
	}
	const location = bookable.find((l) => l.facts.id === wanted)
	if (!location) {
		return {
			ok: false,
			result: fail('unavailable', "We aren't taking bookings there right now."),
		}
	}
	return { ok: true, context, location }
}

function mapServiceError(error: unknown): VoiceActionResult {
	if (error instanceof HttpError) {
		switch (error.code) {
			case 'slot_unavailable':
				return fail('conflict', 'That time was just taken.')
			case 'large_party':
				return fail('unavailable', 'That party is too large to book by phone.')
			case 'party_size_invalid':
				return fail('invalid', "We can't seat that many people by phone.")
			case 'rate_limited':
				return fail('rate_limited', "I can't take more bookings right now.")
			case 'policy_unavailable':
				return fail('unavailable', "I can't take bookings for that right now.")
			case 'not_found':
				return fail('unavailable', "We aren't taking bookings there right now.")
			case 'phone_overlap':
				return fail('conflict', 'That number already has a booking then.')
			case 'policy_required':
				return fail('not_enabled', 'That booking needs a deposit.')
			default:
				return fail('unavailable', "I can't do that right now.")
		}
	}
	console.error(
		'Voice reservation action failed',
		error instanceof Error ? error.name : 'error',
	)
	return fail('unavailable', "I can't do that right now.")
}

async function slotsForRequest(
	ctx: VoiceActionContext,
	resolved: Extract<Resolved, { ok: true }>,
	input: { date: string; partySize: number; time?: string },
) {
	return getPublicAvailability(ctx.db, {
		locationId: resolved.location.facts.id,
		date: input.date,
		partySize: input.partySize,
		localMin: input.time ? toMinutes(input.time) : null,
		locale: 'en',
		now: ctx.now,
		location: resolved.location,
		features: resolved.context.features,
	})
}

/** The slot's engine row, when the public engine offers that exact time. */
function findOfferedSlot(
	result: Awaited<ReturnType<typeof getPublicAvailability>>,
	localTime: string,
) {
	const wanted = toMinutes(localTime)
	return result.slots.find((slot) => slot.localMin === wanted) ?? null
}

async function requiresPayment(
	ctx: VoiceActionContext,
	resolved: Extract<Resolved, { ok: true }>,
	serviceId: string,
	partySize: number,
): Promise<boolean | null> {
	try {
		const view = await describeBookingPolicy(ctx.db, {
			context: resolved.context,
			locationId: resolved.location.facts.id,
			serviceId,
			experienceId: null,
			partySize,
			locale: 'en',
		})
		return view.requiresPayment
	} catch {
		// A policy no processor can take: the slot cannot be booked at all.
		return null
	}
}

const availabilityAction = {
	name: VOICE_ACTION_NAMES.availability,
	schema: availabilitySchema,
	maxPerCall: VOICE_ACTION_CAPS.availability,
	async run(
		ctx: VoiceActionContext,
		input: z.infer<typeof availabilitySchema>,
	): Promise<VoiceActionResult> {
		const resolved = await resolveBooking(ctx, input.locationId)
		if (!resolved.ok) return resolved.result
		try {
			const result = await slotsForRequest(ctx, resolved, input)
			if (result.status === 'large_party') {
				return fail('unavailable', 'That party is too large to book by phone.')
			}
			const target = input.time ? toMinutes(input.time) : null
			const nearest = [...result.slots]
				.sort((a, b) =>
					target === null
						? a.localMin - b.localMin
						: Math.abs(a.localMin - target) - Math.abs(b.localMin - target) ||
							a.localMin - b.localMin,
				)
				.slice(0, MAX_VOICE_SLOTS * 3)
			const slots: Array<{
				localTime: string
				partySizeFits: true
				requiresPayment: boolean
			}> = []
			for (const slot of nearest) {
				const pays = await requiresPayment(
					ctx,
					resolved,
					slot.serviceId,
					input.partySize,
				)
				if (pays === null) continue
				slots.push({
					localTime: slot.time,
					partySizeFits: true,
					requiresPayment: pays,
				})
				if (slots.length === MAX_VOICE_SLOTS) break
			}
			slots.sort((a, b) => a.localTime.localeCompare(b.localTime))
			return {
				ok: true,
				data: {
					date: input.date,
					partySize: input.partySize,
					status: result.status,
					mode: resolved.location.settings.voiceMode,
					holdMinutes: resolved.location.settings.voiceHoldMinutes,
					slots,
					...(ctx.dryRun ? { simulated: true } : {}),
				},
			}
		} catch (error) {
			return mapServiceError(error)
		}
	},
}

const holdAction = {
	name: VOICE_ACTION_NAMES.hold,
	schema: holdSchema,
	maxPerCall: VOICE_ACTION_CAPS.hold,
	async run(
		ctx: VoiceActionContext,
		input: z.infer<typeof holdSchema>,
	): Promise<VoiceActionResult> {
		const resolved = await resolveBooking(ctx, input.locationId)
		if (!resolved.ok) return resolved.result
		// The link opens the online booking flow, so it must be on too.
		if (!resolved.context.features.online) return NOT_ENABLED
		const { settings } = resolved.location
		const locationId = resolved.location.facts.id
		try {
			const offered = findOfferedSlot(
				await slotsForRequest(ctx, resolved, {
					date: input.slot.date,
					partySize: input.partySize,
					time: input.slot.localTime,
				}),
				input.slot.localTime,
			)
			if (!offered) return fail('conflict', 'That time is no longer free.')
			// Fail closed before anything is held.
			await describeBookingPolicy(ctx.db, {
				context: resolved.context,
				locationId,
				serviceId: offered.serviceId,
				experienceId: null,
				partySize: input.partySize,
				locale: 'en',
			})
			if (ctx.dryRun) {
				return {
					ok: true,
					data: {
						held: true,
						simulated: true,
						holdMinutes: settings.voiceHoldMinutes,
					},
				}
			}
			const token = newHoldToken()
			const created = await createHold({
				orgId: ctx.orgId,
				locationId,
				slot: {
					date: input.slot.date,
					localMin: toMinutes(input.slot.localTime),
					partySize: input.partySize,
					serviceId: offered.serviceId,
				},
				tokenHash: hashHoldToken(token),
				source: 'voice_agent',
				voiceCallId: ctx.call.id,
				holdMinutes: settings.voiceHoldMinutes,
				ipHash: null,
				now: ctx.now,
			})
			// The token goes to the voice worker only to be texted as a link; the
			// tool never says it to the model or the caller.
			return {
				ok: true,
				data: {
					held: true,
					holdMinutes: settings.voiceHoldMinutes,
					expiresAt: new Date(created.expiresAt).toISOString(),
					resumeFragment: `h=${token}`,
				},
			}
		} catch (error) {
			return mapServiceError(error)
		}
	},
}

const bookAction = {
	name: VOICE_ACTION_NAMES.book,
	schema: bookSchema,
	maxPerCall: VOICE_ACTION_CAPS.book,
	async run(
		ctx: VoiceActionContext,
		input: z.infer<typeof bookSchema>,
	): Promise<VoiceActionResult> {
		const resolved = await resolveBooking(ctx, input.locationId)
		if (!resolved.ok) return resolved.result
		const { settings } = resolved.location
		if (settings.voiceMode !== 'confirm_on_call') return NOT_ENABLED
		const locationId = resolved.location.facts.id

		// The caller's number is the only contact; it never comes from the model.
		const phone = ctx.call.callerPhone
		// A test call has no caller number and books nothing.
		if (!ctx.dryRun && (!phone || !isUsOrCanadaNumber(phone))) {
			return fail(
				'invalid',
				"I can only book with the number you're calling from, and I don't have a US number for this call.",
			)
		}
		try {
			const offered = findOfferedSlot(
				await slotsForRequest(ctx, resolved, {
					date: input.slot.date,
					partySize: input.partySize,
					time: input.slot.localTime,
				}),
				input.slot.localTime,
			)
			if (!offered) return fail('conflict', 'That time is no longer free.')
			// A payment policy turns direct booking off, whatever the setting says.
			const plan = await planBookingPayment(ctx.db, {
				context: resolved.context,
				locationId,
				serviceId: offered.serviceId,
				experienceId: null,
				partySize: input.partySize,
				locale: 'en',
			})
			if (plan.required) {
				return fail(
					'not_enabled',
					'That booking needs a deposit or a card, which is done on the link.',
				)
			}
			if (ctx.dryRun) {
				return {
					ok: true,
					data: { booked: true, simulated: true },
				}
			}

			const token = newHoldToken()
			const tokenHash = hashHoldToken(token)
			await createHold({
				orgId: ctx.orgId,
				locationId,
				slot: {
					date: input.slot.date,
					localMin: toMinutes(input.slot.localTime),
					partySize: input.partySize,
					serviceId: offered.serviceId,
				},
				tokenHash,
				source: 'voice_agent',
				voiceCallId: ctx.call.id,
				holdMinutes: settings.voiceHoldMinutes,
				ipHash: null,
				now: ctx.now,
			})
			try {
				await bookFromHold({
					orgId: ctx.orgId,
					holdTokenHash: tokenHash,
					input: {
						guest: {
							firstName: input.firstName,
							lastName: input.lastName ?? '',
							phone: phone!,
							email: null,
							locale: 'en',
						},
						smsOptIn: true,
						marketing: false,
						policyAccepted: false,
					},
					client: 'voice_agent',
					channel: 'online',
					customerId: null,
					ipHash: 'voice_agent',
					idempotencyScope: 'voice_book',
					idempotencyKey: `call:${ctx.call.id}`,
					requestHash: hashIdempotencyPayload({
						locationId,
						slot: input.slot,
						partySize: input.partySize,
					}),
					context: resolved.context,
					now: ctx.now,
				})
			} catch (error) {
				// Nothing is left holding the table if the booking was refused.
				await releaseHoldByTokenHash(ctx.orgId, tokenHash).catch(
					() => undefined,
				)
				throw error
			}
			return { ok: true, data: { booked: true } }
		} catch (error) {
			return mapServiceError(error)
		}
	},
}

/**
 * Registers the reservation actions and the `/reserve#h=` link fragment.
 * Called at startup in both the Node and the Workers entry points.
 */
export function registerReservationVoiceActions() {
	registerVoiceAction(availabilityAction)
	registerVoiceAction(holdAction)
	registerVoiceAction(bookAction)
	registerVoiceLinkFragment({
		path: RESERVE_PATH,
		async verify({ db, callId, now }, fragment) {
			const match = /^h=(.+)$/.exec(fragment)
			const token = match?.[1]
			if (!isWellFormedHoldToken(token)) return false
			// Only a live hold this very call took may be texted.
			const hold = await db
				.select({ id: rsvHolds.id })
				.from(rsvHolds)
				.where(
					and(
						eq(rsvHolds.tokenHash, hashHoldToken(token)),
						eq(rsvHolds.voiceCallId, callId),
						eq(rsvHolds.source, 'voice_agent'),
						eq(rsvHolds.status, 'active'),
						gt(rsvHolds.expiresAt, now),
					),
				)
				.get()
			return hold !== undefined
		},
	})
}
