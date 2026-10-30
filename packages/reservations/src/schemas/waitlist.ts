import { z } from 'zod'
import { isoTimestampSchema, partySizeSchema } from './common.ts'

/** Stored statuses of a waitlist entry; the first three are the active queue. */
export const WAITLIST_STATUSES = [
	'waiting',
	'notified',
	'on_the_way',
	'seated',
	'cancelled',
	'left',
	'no_response',
] as const

export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number]

export const waitlistStatusSchema = z.enum(WAITLIST_STATUSES)

/** Statuses a host can still act on; the server counts exactly these in the queue. */
export const ACTIVE_WAITLIST_STATUSES = [
	'waiting',
	'notified',
	'on_the_way',
] as const satisfies readonly WaitlistStatus[]

/** Statuses `POST /:id/status` accepts. */
export const WAITLIST_STATUS_TARGETS = [
	'waiting',
	'on_the_way',
	'no_response',
	'left',
	'cancelled',
] as const satisfies readonly WaitlistStatus[]

export type WaitlistStatusTarget = (typeof WAITLIST_STATUS_TARGETS)[number]

/** How to seat a party on a table that is taken. `overbook` seats it anyway. */
export const WAITLIST_SEAT_RESOLUTIONS = ['swap', 'move', 'overbook'] as const
export type WaitlistSeatResolution = (typeof WAITLIST_SEAT_RESOLUTIONS)[number]

const idField = z.string().trim().min(1).max(128)
const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const epochMs = z.number().nullable()

// ---------------------------------------------------------------------------
// Operator requests (`/operator/reservations/book/waitlist`)
// ---------------------------------------------------------------------------

const entryFields = {
	displayName: z.string().trim().min(1).max(120),
	partySize: z.number().int().min(1).max(99),
	phone: z.string().trim().max(32).optional().nullable(),
	email: z.string().trim().max(254).optional().nullable(),
	smsOptIn: z.boolean().optional(),
	areaPrefId: idField.optional().nullable(),
	areaId: idField.optional().nullable(),
	notes: z.string().max(1000).optional().nullable(),
	locale: z.string().trim().min(2).max(16).optional(),
}

export const operatorAddWaitlistEntrySchema = z.object({
	locationId: idField,
	...entryFields,
	idempotencyKey: z.string().trim().min(1).max(128).optional(),
})

export const operatorUpdateWaitlistEntrySchema = z.object({
	locationId: idField.optional(),
	expectedVersion: z.number().int().min(1).optional(),
	displayName: entryFields.displayName.optional(),
	partySize: entryFields.partySize.optional(),
	phone: entryFields.phone,
	email: entryFields.email,
	smsOptIn: entryFields.smsOptIn,
	areaPrefId: entryFields.areaPrefId,
	areaId: entryFields.areaId,
	notes: entryFields.notes,
})

export const operatorNotifyWaitlistEntrySchema = z.object({
	locationId: idField.optional(),
	expectedVersion: z.number().int().min(1).optional(),
})

export const operatorWaitlistStatusSchema = z.object({
	locationId: idField.optional(),
	status: z.enum(WAITLIST_STATUS_TARGETS),
	expectedVersion: z.number().int().min(1).optional(),
})

export const operatorSeatWaitlistEntrySchema = z.object({
	locationId: idField.optional(),
	tableIds: z.array(idField).max(20).optional(),
	partySize: z.number().int().min(1).max(99).optional(),
	expectedVersion: z.number().int().min(1).optional(),
	overbook: z.boolean().optional(),
	overbookReason: z.string().max(500).optional().nullable(),
	resolution: z.enum(WAITLIST_SEAT_RESOLUTIONS).optional(),
	/** With `move`: where the occupant goes (default: the best free table). */
	moveToTableIds: z.array(idField).min(1).max(20).optional(),
	idempotencyKey: z.string().trim().min(1).max(128).optional(),
})

export const operatorReorderWaitlistSchema = z.object({
	locationId: idField,
	date: dateField.optional(),
	businessDate: dateField.optional(),
	ids: z.array(idField).min(1).max(500),
})

export const operatorWaitlistListQuerySchema = z.object({
	locationId: idField,
	date: dateField.optional(),
	businessDate: dateField.optional(),
})

export const operatorWaitlistQuoteQuerySchema = z.object({
	locationId: idField,
	partySize: z.coerce.number().int().min(1).max(99),
	areaId: idField.optional(),
	areaPrefId: idField.optional(),
})

// ---------------------------------------------------------------------------
// Operator responses (times are epoch milliseconds)
// ---------------------------------------------------------------------------

export const waitlistEntrySchema = z.object({
	id: z.string(),
	locationId: z.string(),
	businessDate: z.string(),
	guestId: z.string().nullable(),
	displayName: z.string(),
	firstName: z.string(),
	lastName: z.string(),
	phone: z.string().nullable(),
	email: z.string().nullable(),
	partySize: z.number().int(),
	areaPrefId: z.string().nullable(),
	channel: z.enum(['walk_in', 'remote']),
	status: waitlistStatusSchema,
	quotedMin: z.number().nullable(),
	quotedReadyAt: epochMs,
	notifiedAt: epochMs,
	responseDeadlineAt: epochMs,
	reservationId: z.string().nullable(),
	sortKey: z.number(),
	notes: z.string().nullable(),
	smsOptIn: z.boolean(),
	locale: z.string().nullable().optional(),
	version: z.number().int(),
	joinedAt: z.number(),
	createdAt: z.number(),
	position: z.number().int().nullable(),
})

export type WaitlistEntry = z.infer<typeof waitlistEntrySchema>

export const waitlistListingSchema = z.object({
	locationId: z.string(),
	businessDate: z.string(),
	now: z.number(),
	waitlistResponseMin: z.number().int(),
	counts: z.object({
		active: z.number().int(),
		waiting: z.number().int(),
		notified: z.number().int(),
		onTheWay: z.number().int(),
	}),
	entries: z.array(waitlistEntrySchema),
})

export type WaitlistListing = z.infer<typeof waitlistListingSchema>

export const waitlistQuoteSchema = z.object({
	locationId: z.string(),
	businessDate: z.string(),
	partySize: z.number().int(),
	quotedMin: z.number().nullable(),
	quotedReadyAt: epochMs,
	position: z.number().int(),
	now: z.number(),
})

export type WaitlistQuote = z.infer<typeof waitlistQuoteSchema>

/** `POST /` and `PATCH /:id`. */
export const waitlistEntryResponseSchema = z.object({
	entry: waitlistEntrySchema,
})

/** `POST /:id/notify` and `POST /:id/status`; `changed` is false on a repeated call. */
export const waitlistEntryChangeResponseSchema = z.object({
	entry: waitlistEntrySchema,
	changed: z.boolean().optional(),
})

export const waitlistSeatMoveSchema = z.object({
	reservationId: z.string(),
	bookingId: z.string().optional(),
	fromTableIds: z.array(z.string()),
	toTableIds: z.array(z.string()),
	toCombinationId: z.string().nullable().optional(),
})

export const waitlistSeatResponseSchema = z.object({
	entry: waitlistEntrySchema,
	reservation: z.object({ id: z.string() }).loose().nullable(),
	moves: z.array(waitlistSeatMoveSchema).default([]),
})

export const waitlistSeatOccupantSchema = z.object({
	kind: z.enum(['reservation', 'hold', 'block']),
	reservationId: z.string().nullable(),
	confirmationCode: z.string().nullable(),
	status: z.string().nullable(),
	partySize: z.number().int().nullable(),
	startAt: z.number(),
	endAt: z.number(),
	tableIds: z.array(z.string()),
	/** Only for tokens that may read guest details. */
	guestName: z.string().nullable(),
})

/** Body of the 409 `table_occupied` answer to a seat on a taken table. */
export const waitlistSeatConflictSchema = z.object({
	error: z.literal('table_occupied'),
	occupant: waitlistSeatOccupantSchema,
	occupants: z.array(waitlistSeatOccupantSchema).min(1),
	/** Resolutions the server would accept for these occupants. */
	resolutions: z.array(z.enum(WAITLIST_SEAT_RESOLUTIONS)).min(1),
})

// ---------------------------------------------------------------------------
// Public guest routes (`/reservations/waitlist/*`, times are ISO strings)
// ---------------------------------------------------------------------------

export const publicJoinWaitlistSchema = z
	.object({
		locationId: idField,
		name: z.string().trim().min(1).max(120).optional(),
		displayName: z.string().trim().min(1).max(120).optional(),
		partySize: z.number().int().min(1).max(99),
		phone: z.string().trim().max(32).optional().nullable(),
		email: z.string().trim().max(254).optional().nullable(),
		smsOptIn: z.boolean().optional(),
		areaId: idField.optional().nullable(),
		notes: z.string().trim().max(300).optional().nullable(),
		locale: z.string().trim().min(2).max(16).optional(),
		website: z.string().max(200).optional(),
		turnstileToken: z.string().max(4096).optional(),
	})
	.refine((v) => Boolean(v.name ?? v.displayName), {
		path: ['name'],
		message: 'required',
	})

const nullableIso = isoTimestampSchema.nullable()

export const publicJoinWaitlistResponseSchema = z.object({
	entry: z.object({
		id: z.string(),
		locationId: z.string(),
		locationName: z.string().nullable(),
		status: waitlistStatusSchema,
		position: z.number().int().nullable(),
		partySize: partySizeSchema,
		quotedMin: z.number().nullable(),
		quotedReadyAt: nullableIso,
	}),
	statusToken: z.string(),
	now: isoTimestampSchema,
})

/** `GET /waitlist/status` and the leave and on-my-way actions. */
export const publicWaitlistStatusResponseSchema = z.object({
	status: waitlistStatusSchema,
	position: z.number().int().nullable(),
	partySize: partySizeSchema,
	quotedMin: z.number().nullable(),
	quotedReadyAt: nullableIso,
	locationName: z.string().nullable(),
	notifiedAt: nullableIso,
	responseDeadlineAt: nullableIso,
	canLeave: z.boolean(),
	canOnMyWay: z.boolean(),
	now: isoTimestampSchema,
})

export const waitlistOfferResponseSchema = z.strictObject({
	entryId: z.string().trim().min(1),
	status: waitlistStatusSchema,
	partySize: partySizeSchema.optional(),
	position: z.number().int().min(1).optional(),
	quotedWaitMin: z.number().int().min(0).nullable().optional(),
	expiresAt: isoTimestampSchema,
	now: isoTimestampSchema,
})
