import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import { COUNT_KINDS } from '../vocabulary.ts'
import {
	actorSchema,
	clientIdSchema,
	expectedVersionSchema,
	inventoryIdSchema,
	inventoryNoteSchema,
	isoDateSchema,
	minorOut,
	currencyOut,
} from './common.ts'

/**
 * Count controls: quick counts and schedules (#490), the weekly plan and its
 * assignees (#491), the second-person check (#525), devices and late entries
 * (#474). Everything here extends the count model in `counts.ts` (one count,
 * one entry table); nothing is a second way to count.
 */

export const countKindSchema = z.enum(COUNT_KINDS)

/** Two hours without a sync: the device is "not responding" (#474). */
export const COUNT_DEVICE_SILENT_MS = 2 * 60 * 60 * 1000

/** One hour after a scheduled count was due, the manager is told (#491). */
export const COUNT_OVERDUE_ALERT_AFTER_MS = 60 * 60 * 1000

/** "Not counted lately" (#491): the stock filter and the Today number. */
export const NOT_COUNTED_DAYS = 14
export const NOT_COUNTED_MS = NOT_COUNTED_DAYS * 24 * 60 * 60 * 1000

/** Whether an item counted at `lastCountedAt` is over the 14 days (never counted counts as over). */
export function isNotCountedLately(
	lastCountedAt: number | null,
	now: number,
): boolean {
	return lastCountedAt === null || now - lastCountedAt > NOT_COUNTED_MS
}

// ── Schedules ───────────────────────────────────────────────────────────────

export const COUNT_SCHEDULE_SLOTS = ['opening', 'close', 'custom'] as const
export const countScheduleSlotSchema = z.enum(COUNT_SCHEDULE_SLOTS)
export type CountScheduleSlot = (typeof COUNT_SCHEDULE_SLOTS)[number]

/** Who a scheduled count is assigned to: a roster member of the staff module, or a member with a login. */
export const ASSIGNEE_KINDS = ['staff', 'member'] as const
export const assigneeSchema = z
	.object({
		kind: z.enum(ASSIGNEE_KINDS),
		id: inventoryIdSchema,
	})
	.strict()
export type CountAssignee = z.infer<typeof assigneeSchema>

const timeLocalSchema = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Invalid time')

const weekdaysSchema = z
	.array(z.number().int().min(0).max(6))
	.min(1)
	.max(7)
	.transform((days) => [...new Set(days)].sort((a, b) => a - b))

/** `POST /count-schedules` (`update:inventory:any`). */
export const createCountScheduleSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		kind: countKindSchema,
		/** A saved count list; null = everything (full) or the key items (quick). */
		listId: inventoryIdSchema.nullable(),
		slot: countScheduleSlotSchema,
		timeLocal: timeLocalSchema,
		weekdays: weekdaysSchema,
		assignee: assigneeSchema.nullable().optional(),
	})
	.strict()
export type CreateCountSchedule = z.infer<typeof createCountScheduleSchema>

/** `PATCH /count-schedules/:id`: applies from tomorrow, never to a count already started. */
export const updateCountScheduleSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		listId: inventoryIdSchema.nullable().optional(),
		slot: countScheduleSlotSchema.optional(),
		timeLocal: timeLocalSchema.optional(),
		weekdays: weekdaysSchema.optional(),
		assignee: assigneeSchema.nullable().optional(),
	})
	.strict()
export type UpdateCountSchedule = z.infer<typeof updateCountScheduleSchema>

export const countScheduleSchema = z.object({
	id: z.string(),
	locationId: z.string(),
	kind: countKindSchema,
	listId: z.string().nullable(),
	listName: z.string().nullable(),
	slot: countScheduleSlotSchema,
	timeLocal: z.string(),
	weekdays: z.array(z.number().int()),
	assignee: assigneeSchema.nullable(),
	/** The first business day this version of the schedule applies to. */
	effectiveFrom: isoDateSchema,
	version: z.number().int(),
})
export type CountSchedule = z.infer<typeof countScheduleSchema>

export const listCountSchedulesQuerySchema = z
	.object({ locationId: inventoryLocationIdSchema })
	.strict()
export const listCountSchedulesResultSchema = z.object({
	schedules: z.array(countScheduleSchema),
})

/** One scheduled occurrence on one business day (what Today, Station and my-schedule show). */
export const COUNT_RUN_STATUSES = ['due', 'started', 'not_finished'] as const
export const countRunSchema = z.object({
	id: z.string(),
	scheduleId: z.string(),
	locationId: z.string(),
	date: isoDateSchema,
	dueAt: z.number().int(),
	kind: countKindSchema,
	listId: z.string().nullable(),
	listName: z.string().nullable(),
	slot: countScheduleSlotSchema,
	assignee: assigneeSchema.nullable(),
	/** For a member assignee who is also on the roster: that staff id, so a till can show it to them. */
	assigneeStaffId: z.string().nullable().optional(),
	countId: z.string().nullable(),
	status: z.enum(COUNT_RUN_STATUSES),
	/** An hour has passed since the due time and no count was started (the manager is told then). */
	late: z.boolean(),
})
export type CountRun = z.infer<typeof countRunSchema>

/** `GET /count-runs?locationId=&date=`: the day's runs (default today). */
export const listCountRunsQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		date: isoDateSchema.optional(),
	})
	.strict()
export const listCountRunsResultSchema = z.object({
	date: isoDateSchema,
	runs: z.array(countRunSchema),
})

/** `PATCH /locations/:locationId/count-controls`: the location's second-person rule (#525). */
export const updateLocationCountControlsSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		secondCountRequired: z.boolean(),
	})
	.strict()

// ── Devices (#474) ──────────────────────────────────────────────────────────

/** A device reporting itself on an entries request (a browser or phone; Station uses its terminal id). */
export const countDeviceReportSchema = z
	.object({
		id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid device id'),
		name: z.string().trim().max(60).optional(),
		/** What kind of device (default `app`: the operator web app). */
		kind: z.enum(['app', 'phone']).optional(),
		/** Entries the device still holds unsent after this request. */
		unsent: z.number().int().min(0).max(100_000),
		/** The person tapped "I'm done counting". */
		done: z.boolean().optional(),
	})
	.strict()
export type CountDeviceReport = z.infer<typeof countDeviceReportSchema>

/** `POST /counts/:id/presence`: a device reports without entries (the app is idle or about to go offline). */
export const countPresenceSchema = z
	.object({ device: countDeviceReportSchema })
	.strict()

export const COUNT_DEVICE_STATES = [
	'counting',
	'not_responding',
	'done',
] as const
export const countDeviceSchema = z.object({
	deviceId: z.string(),
	name: z.string().nullable(),
	kind: z.string(),
	person: actorSchema,
	joinedAt: z.number().int(),
	lastSyncAt: z.number().int(),
	/** Entries the device reported unsent; null when it never said. */
	unsentCount: z.number().int().nullable(),
	state: z.enum(COUNT_DEVICE_STATES),
})
export type CountDevice = z.infer<typeof countDeviceSchema>

// ── Late entries (#474) ─────────────────────────────────────────────────────

export const LATE_ENTRY_STATUSES = ['open', 'applied', 'dismissed'] as const
export const countLateEntrySchema = z.object({
	id: z.string(),
	countId: z.string(),
	itemId: z.string(),
	itemName: z.string(),
	areaId: z.string().nullable(),
	/** Base thousandths counted by that entry's person. */
	quantity: z.number().int(),
	counter: actorSchema,
	countedAt: z.number().int(),
	receivedAt: z.number().int(),
	status: z.enum(LATE_ENTRY_STATUSES),
	/** What applying it would change now (base thousandths, signed), when it is open. */
	adjustment: z.number().int().nullable().optional(),
	/** A later approved count measured this item after the entry: applying it adds nothing. */
	superseded: z.boolean().optional(),
	adjustmentValueMinor: minorOut,
	currency: currencyOut,
})
export type CountLateEntry = z.infer<typeof countLateEntrySchema>

export const countLateEntriesResultSchema = z.object({
	entries: z.array(countLateEntrySchema),
})

/** `POST /counts/:id/late-entries/:entryId/apply` (the "add to a correction" tap) and `/dismiss`. */
export const resolveLateEntrySchema = z
	.object({ clientId: clientIdSchema, note: inventoryNoteSchema.optional() })
	.strict()

export const resolveLateEntryResultSchema = z.object({
	entry: countLateEntrySchema,
	/** The correction posted, in base thousandths; 0 when nothing needed to move. */
	adjustment: z.number().int(),
})

// ── Second-person check (#525) ──────────────────────────────────────────────

export const COUNT_SECOND_STATES = [
	'waiting',
	'settling',
	'done',
	'skipped',
] as const
export const countSecondStateSchema = z.enum(COUNT_SECOND_STATES)
export type CountSecondState = (typeof COUNT_SECOND_STATES)[number]

export const SECOND_RESOLUTIONS = ['first', 'second'] as const
export const secondResolutionSchema = z.enum(SECOND_RESOLUTIONS)

/** One key item counted twice, side by side. */
export const countSecondCheckLineSchema = z.object({
	itemId: z.string(),
	name: z.string(),
	baseUnit: z.enum(['g', 'ml', 'piece']),
	firstQuantity: z.number().int().nullable(),
	secondQuantity: z.number().int().nullable(),
	matches: z.boolean(),
	resolution: secondResolutionSchema.nullable(),
})

export const countSecondCheckSchema = z.object({
	state: countSecondStateSchema.nullable(),
	/** Key items the second person must count; empty unless the check applies. */
	keyItemCount: z.number().int(),
	secondCounters: z.array(actorSchema),
	lines: z.array(countSecondCheckLineSchema),
	skipReason: z.string().nullable(),
})
export type CountSecondCheck = z.infer<typeof countSecondCheckSchema>

/** `POST /counts/:id/second/finish`: the second person is done counting key items. */
/** `POST /counts/:id/second/settle`: per differing item, which figure stands. */
export const settleSecondCheckSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		resolutions: z
			.record(inventoryIdSchema, secondResolutionSchema)
			.refine((value) => Object.keys(value).length > 0, 'Nothing to settle'),
	})
	.strict()

/** `POST /counts/:id/second/skip`: a manager skips the check with a reason (recorded). */
export const skipSecondCheckSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		reason: z.string().trim().min(3).max(200),
	})
	.strict()
