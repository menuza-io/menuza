import { z } from 'zod'
import {
	CLOCK_EVENTS,
	type ClockEvent,
	type ClockState,
} from './clock-state.ts'
import { BREAK_KINDS, type BreakKind } from './labor-policy.ts'
import { timeZoneSchema } from './schemas.ts'

/**
 * Request and response contracts for the time clock: the public `/kiosk`
 * routes (device-secret auth) and the manager routes under
 * `/operator/timeclock`. App code and tenant-api import the same schemas.
 * Request schemas are `.strict()`: an unknown key is a 400.
 */

const idSchema = z.string().min(1).max(64)

export const KIOSK_IDENTIFY_MODES = ['pin', 'pick_name'] as const
export type KioskIdentifyMode = (typeof KIOSK_IDENTIFY_MODES)[number]

// ---------------------------------------------------------------------------
// Manager routes: pairing codes and devices
// ---------------------------------------------------------------------------

export const kioskPairingCodeCreateSchema = z
	.object({
		scopeId: idSchema,
		/** Shown to managers in the device list, for example "Front counter". */
		deviceName: z.string().trim().min(1).max(60),
		identifyMode: z.enum(KIOSK_IDENTIFY_MODES).default('pin'),
		showNextShifts: z.boolean().default(false),
		/** Scope facts the control plane knows; used until it can be reached. */
		timeZone: timeZoneSchema.optional(),
		scopeName: z.string().trim().min(1).max(120).optional(),
	})
	.strict()
export type KioskPairingCodeCreate = z.infer<
	typeof kioskPairingCodeCreateSchema
>

export const kioskDeviceUpdateSchema = z
	.object({
		name: z.string().trim().min(1).max(60),
		identifyMode: z.enum(KIOSK_IDENTIFY_MODES),
		showNextShifts: z.boolean(),
	})
	.partial()
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type KioskDeviceUpdate = z.infer<typeof kioskDeviceUpdateSchema>

// ---------------------------------------------------------------------------
// Kiosk routes
// ---------------------------------------------------------------------------

export const kioskPairRequestSchema = z
	.object({ code: z.string().min(20).max(160) })
	.strict()

/** A PIN as typed: digits, possibly Arabic-Indic. Length is checked by policy. */
const pinInputSchema = z
	.string()
	.min(1)
	.max(12)
	.regex(/^[0-9٠-٩۰-۹]+$/, 'Digits only')

const clientTimestampSchema = z.number().int().min(0).max(4_102_444_800_000)

export const kioskIdentifySchema = z
	.object({
		pin: pinInputSchema,
		/** Pick-name devices send the person they picked. */
		staffId: idSchema.optional(),
	})
	.strict()
export type KioskIdentifyRequest = z.infer<typeof kioskIdentifySchema>

export const kioskPunchSchema = z
	.object({
		/** Client-generated; makes a retry safe. */
		id: z.string().uuid(),
		kind: z.enum(CLOCK_EVENTS),
		pin: pinInputSchema,
		staffId: idSchema.optional(),
		/** Role pick for staff with several positions at the scope. */
		positionId: idSchema.optional(),
		breakKind: z.enum(BREAK_KINDS).optional(),
		/** The device clock when the person tapped. */
		clientAt: clientTimestampSchema,
		/** The device clock when this request was sent (detects skew on queued punches). */
		deviceNowAt: clientTimestampSchema.optional(),
		/** True when the punch waited in the device queue. */
		offline: z.boolean().default(false),
		/** Tips declared at clock-out, integer minor units. */
		cashTipsMinor: z.number().int().min(0).max(1_000_000).optional(),
	})
	.strict()
export type KioskPunchRequest = z.infer<typeof kioskPunchSchema>

/** Stable machine codes for everything a kiosk can be told. */
export const KIOSK_ERROR_CODES = [
	'kiosk_disabled',
	'invalid_device',
	'device_revoked',
	'invalid_pairing_code',
	'invalid_pin',
	'backoff',
	'person_locked',
	'not_available',
	'time_tracking_disabled',
	'already_clocked_in',
	'not_clocked_in',
	'already_on_break',
	'not_on_break',
	'clocked_in_elsewhere',
	'overlaps_previous_entry',
	'time_conflict',
	'early_clock_in',
	'unscheduled_not_allowed',
	'position_required',
	'invalid_position',
	'punch_in_future',
	'punch_too_old',
	'punch_id_conflict',
	'time_zone_unavailable',
] as const
export type KioskErrorCode = (typeof KIOSK_ERROR_CODES)[number]

export type KioskPositionOption = {
	id: string
	name: string
	nameAr: string | null
}

/** First name only: the kiosk is a shared screen. */
export type KioskIdentifyResult = {
	firstName: string
	state: ClockState
	allowedEvents: ClockEvent[]
	/** Present when a clock-in needs a role pick. */
	positions: KioskPositionOption[]
	/** Opt-in per device; empty until scheduling ships. */
	nextShifts: Array<{ startAt: number; endAt: number }>
	/**
	 * True when the open shift is under a role that receives tips, so the
	 * tablet may offer a cash-tip declaration at clock-out.
	 */
	promptTips: boolean
	/**
	 * The breaks a person may start, when the workplace's rules name more than
	 * the default meal break (`meal` and `rest`); empty means a plain break.
	 */
	breakKinds: BreakKind[]
	serverNow: number
}

export type KioskPunchResult = {
	outcome: 'accepted'
	/** True when this id was already processed and the stored result is replayed. */
	duplicate: boolean
	kind: ClockEvent
	state: ClockState
	firstName: string
	/** The instant the punch counts at (server time unless queued offline). */
	at: number
	serverNow: number
}

export type KioskConfig = {
	device: {
		id: string
		name: string
		scopeId: string
		identifyMode: KioskIdentifyMode
		showNextShifts: boolean
	}
	scope: { name: string | null; timeZone: string | null }
	serverNow: number
}

export type KioskPerson = {
	staffId: string
	firstName: string
	lastInitial: string
}

// ---------------------------------------------------------------------------
// Manager route: today's status
// ---------------------------------------------------------------------------

/** Someone clocked in right now (a manager view: full names, no pay). */
export type TimeclockTodayRow = {
	entryId: string
	staffId: string
	firstName: string
	lastName: string
	scopeId: string
	/** The scope's time zone when the entry was created; times display in it. */
	timeZone: string
	positionId: string | null
	positionName: string | null
	positionNameAr: string | null
	state: Extract<ClockState, 'in' | 'on_break'>
	clockInAt: number
	/** Set while `state` is `on_break`. */
	breakStartAt: number | null
	issues: string[]
	/** Only judged when a schedule exists; false otherwise. */
	late: boolean
	/** Still clocked in past the long-shift limit or the scheduled end. */
	missingClockOut: boolean
}

export type TimeclockTodayRecent = {
	entryId: string
	staffId: string
	firstName: string
	lastName: string
	scopeId: string
	timeZone: string
	clockInAt: number
	clockOutAt: number
	issues: string[]
	needsReview: boolean
}

export type TimeclockTodayResponse = {
	serverNow: number
	present: TimeclockTodayRow[]
	recent: TimeclockTodayRecent[]
}
