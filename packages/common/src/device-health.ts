import { z } from 'zod'

/**
 * Station connection history (#356). A terminal sends a heartbeat at most once
 * a minute while it is open; the region keeps a row per minute for 30 days and
 * a daily summary after that. Whether a gap is an outage is decided here, from
 * the minutes the terminal checked in and the location's opening hours: a
 * tablet switched off overnight is never reported, and with no opening hours
 * nothing is called an outage (the gap is "unknown").
 *
 * Nothing in a heartbeat names a person, an order or a guest.
 */

export const HEARTBEAT_INTERVAL_MS = 60_000
/** While the flag is off for the organization, the terminal asks again this often. */
export const HEARTBEAT_RECHECK_MS = 10 * 60_000
export const HEALTH_DETAIL_DAYS = 30
export const HEALTH_STRIP_DAYS = 7
/** A gap of at least this many minutes during opening hours is an outage. */
export const OUTAGE_GRACE_MINUTES = 3
const MINUTE = 60_000
/** Resolution of the strip: 15 minutes a cell. */
export const STRIP_CELL_MINUTES = 15

/** What a terminal can truthfully report about a printer (none can in a browser today). */
export const PRINTER_STATES = [
	'ok',
	'out_of_paper',
	'cover_open',
	'error',
	'offline',
] as const

export const heartbeatSchema = z.strictObject({
	appVersion: z.string().trim().max(40).nullable().optional(),
	browser: z.string().trim().max(60).nullable().optional(),
	batteryPct: z.number().int().min(0).max(100).nullable().optional(),
	charging: z.boolean().nullable().optional(),
	storageUsedMb: z.number().int().min(0).max(100_000_000).nullable().optional(),
	storageQuotaMb: z
		.number()
		.int()
		.min(0)
		.max(100_000_000)
		.nullable()
		.optional(),
	/** Orders and shifts still waiting to upload: a count, never their content. */
	pendingUploads: z.number().int().min(0).max(1_000_000).nullable().optional(),
	/** When the till last delivered an order or shift (epoch ms). */
	lastUploadAt: z.number().int().min(0).nullable().optional(),
	/** Filled only when the till really reads a printer. */
	printerState: z.enum(PRINTER_STATES).nullable().optional(),
	/** Filled only when the till really reads the drawer (epoch ms). */
	drawerOpenedAt: z.number().int().min(0).nullable().optional(),
	/** The shift the till had open at the time, an id only. */
	drawerShiftId: z.string().trim().max(100).nullable().optional(),
})
export type Heartbeat = z.infer<typeof heartbeatSchema>

export type Interval = { startMs: number; endMs: number }

export const minuteBucket = (ms: number) => Math.floor(ms / MINUTE) * MINUTE

/**
 * The time a terminal was checking in, as merged intervals: each bucket covers
 * its own minute and a gap shorter than the grace is bridged (a heartbeat
 * delayed by a slow network is not an outage).
 */
export function presenceIntervals(
	buckets: readonly number[],
	graceMinutes = OUTAGE_GRACE_MINUTES,
): Interval[] {
	const sorted = [...new Set(buckets)].sort((a, b) => a - b)
	const out: Interval[] = []
	for (const bucket of sorted) {
		const last = out[out.length - 1]
		if (last && bucket - last.endMs < graceMinutes * MINUTE)
			last.endMs = bucket + MINUTE
		else out.push({ startMs: bucket, endMs: bucket + MINUTE })
	}
	return out
}

/** `outer` minus every interval of `holes` (both sorted, non-overlapping). */
function subtract(outer: Interval, holes: readonly Interval[]): Interval[] {
	const out: Interval[] = []
	let cursor = outer.startMs
	for (const hole of holes) {
		if (hole.endMs <= cursor) continue
		if (hole.startMs >= outer.endMs) break
		if (hole.startMs > cursor)
			out.push({ startMs: cursor, endMs: hole.startMs })
		cursor = Math.max(cursor, hole.endMs)
	}
	if (cursor < outer.endMs) out.push({ startMs: cursor, endMs: outer.endMs })
	return out
}

export type Outage = {
	startMs: number
	endMs: number
	minutes: number
	/** Still going: the terminal has not checked in since. */
	ongoing: boolean
}

/**
 * Outages inside `[fromMs, toMs]`: the times the location was open, the
 * terminal was known to exist (`firstSeenAt`, so a new terminal is not offline
 * before it was paired), and it did not check in, for at least the grace.
 * `openIntervals` null means the opening hours are unknown: nothing is
 * inferred.
 */
export function inferOutages(input: {
	presence: readonly Interval[]
	openIntervals: readonly Interval[] | null
	fromMs: number
	toMs: number
	nowMs: number
	firstSeenAt: number | null
	graceMinutes?: number
}): Outage[] {
	if (input.openIntervals === null || input.firstSeenAt === null) return []
	const grace = (input.graceMinutes ?? OUTAGE_GRACE_MINUTES) * MINUTE
	const upper = Math.min(input.toMs, input.nowMs)
	const lower = Math.max(input.fromMs, input.firstSeenAt)
	const out: Outage[] = []
	for (const open of input.openIntervals) {
		const clipped = {
			startMs: Math.max(open.startMs, lower),
			endMs: Math.min(open.endMs, upper),
		}
		if (clipped.endMs <= clipped.startMs) continue
		for (const gap of subtract(clipped, input.presence)) {
			if (gap.endMs - gap.startMs < grace) continue
			out.push({
				startMs: gap.startMs,
				endMs: gap.endMs,
				minutes: Math.round((gap.endMs - gap.startMs) / MINUTE),
				ongoing: gap.endMs >= input.nowMs && open.endMs > input.nowMs,
			})
		}
	}
	return out
}

export const totalOutageMinutes = (outages: readonly Outage[]) =>
	outages.reduce((sum, o) => sum + o.minutes, 0)

export type StripCell = 'online' | 'offline' | 'unknown' | 'closed' | 'future'

/**
 * One day of the strip: cells of `STRIP_CELL_MINUTES`. A cell is `online` when
 * the terminal checked in during it, `offline` when an outage covers it,
 * `closed` when the location was shut and the terminal quiet, `unknown` when
 * nothing can be said (before the terminal's first check-in, or opening hours
 * are not known), and `future` past now.
 */
export function dayStrip(input: {
	dayStartMs: number
	dayEndMs: number
	presence: readonly Interval[]
	openIntervals: readonly Interval[] | null
	outages: readonly Outage[]
	nowMs: number
	firstSeenAt: number | null
}): StripCell[] {
	const cell = STRIP_CELL_MINUTES * MINUTE
	const count = Math.max(
		1,
		Math.round((input.dayEndMs - input.dayStartMs) / cell),
	)
	const cells: StripCell[] = []
	for (let i = 0; i < count; i++) {
		const start = input.dayStartMs + i * cell
		const end = start + cell
		if (start >= input.nowMs) {
			cells.push('future')
			continue
		}
		if (input.presence.some((p) => p.startMs < end && p.endMs > start)) {
			cells.push('online')
			continue
		}
		if (input.firstSeenAt === null || end <= input.firstSeenAt) {
			cells.push('unknown')
			continue
		}
		if (input.openIntervals === null) {
			cells.push('unknown')
			continue
		}
		const mid = start + cell / 2
		if (input.outages.some((o) => o.startMs <= mid && mid < o.endMs)) {
			cells.push('offline')
			continue
		}
		const open = input.openIntervals.some(
			(o) => o.startMs < end && o.endMs > start,
		)
		cells.push(open ? 'online' : 'closed')
	}
	return cells
}

/** Daily summary of old minutes: what the roll-up keeps. */
export type DailyRollup = {
	day: string
	heartbeats: number
	firstAt: number
	lastAt: number
}

/** The UTC calendar day (`YYYY-MM-DD`) of an instant. */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
