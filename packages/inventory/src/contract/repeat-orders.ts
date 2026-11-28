import { expandSpecialHours } from '@repo/opening-hours'
import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import {
	clientIdSchema,
	expectedVersionSchema,
	inventoryIdSchema,
	inventoryNoteSchema,
	isoDateSchema,
} from './common.ts'
import {
	addDaysIso,
	orderCutoffFor,
	weekdayOf,
	type LocalMoment,
	type SupplierSchedule,
} from './orders-rules.ts'

export const REPEAT_ORDER_CADENCE_WEEKS = [1, 2, 4] as const
export type RepeatOrderCadenceWeeks =
	(typeof REPEAT_ORDER_CADENCE_WEEKS)[number]

export const REPEAT_ORDER_MODES = ['fixed_lines', 'top_up'] as const
export type RepeatOrderMode = (typeof REPEAT_ORDER_MODES)[number]

export const REPEAT_ORDER_STATUSES = ['active', 'paused', 'cancelled'] as const
export type RepeatOrderStatus = (typeof REPEAT_ORDER_STATUSES)[number]

export const REPEAT_ORDER_RUN_STATUSES = [
	'skipped',
	'skipped_holiday',
	'drafted',
] as const
export type RepeatOrderRunStatus = (typeof REPEAT_ORDER_RUN_STATUSES)[number]

export const REPEAT_ORDER_EFFECTIVE_STATUSES = [
	'active',
	'paused',
	'paused_supplier',
	'cancelled',
] as const
export type RepeatOrderEffectiveStatus =
	(typeof REPEAT_ORDER_EFFECTIVE_STATUSES)[number]

/** Fallback cut-off when a supplier has no `cutoffTime` configured. */
export const DEFAULT_REPEAT_CUTOFF_TIME = '16:00'
export const DEFAULT_REPEAT_CUTOFF_DAYS_BEFORE = 1
/** Draft orders are created up to 24 hours before the supplier's cut-off. */
export const REPEAT_DRAFT_LEAD_MINUTES = 24 * 60
export const DEFAULT_UPCOMING_RUNS_COUNT = 6

const weekdaySchema = z.number().int().min(0).max(6)
const cadenceWeeksSchema = z.union([z.literal(1), z.literal(2), z.literal(4)])

export const repeatOrderFixedLineSchema = z
	.object({
		itemId: inventoryIdSchema,
		supplierProductId: inventoryIdSchema.nullable().optional(),
		packs: z.number().positive().max(1_000_000),
	})
	.strict()
export type RepeatOrderFixedLine = z.infer<typeof repeatOrderFixedLineSchema>

export const createRepeatOrderSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		supplierId: inventoryIdSchema,
		sourceOrderId: inventoryIdSchema.nullable().optional(),
		cadenceWeeks: cadenceWeeksSchema,
		weekdays: z.array(weekdaySchema).min(1).max(7),
		mode: z.enum(REPEAT_ORDER_MODES).default('fixed_lines'),
		anchorDate: isoDateSchema.optional(),
		lines: z.array(repeatOrderFixedLineSchema).max(200).optional(),
		note: inventoryNoteSchema.nullable().optional(),
	})
	.strict()
export type CreateRepeatOrderInput = z.infer<typeof createRepeatOrderSchema>

export const updateRepeatOrderSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		status: z.enum(REPEAT_ORDER_STATUSES).optional(),
		cadenceWeeks: cadenceWeeksSchema.optional(),
		weekdays: z.array(weekdaySchema).min(1).max(7).optional(),
		mode: z.enum(REPEAT_ORDER_MODES).optional(),
		note: inventoryNoteSchema.nullable().optional(),
	})
	.strict()
export type UpdateRepeatOrderInput = z.infer<typeof updateRepeatOrderSchema>

export const skipRepeatOrderRunSchema = z
	.object({
		deliveryDate: isoDateSchema,
		skipped: z.boolean(),
		note: inventoryNoteSchema.nullable().optional(),
	})
	.strict()
export type SkipRepeatOrderRunInput = z.infer<typeof skipRepeatOrderRunSchema>

export const listRepeatOrdersQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		includeCancelled: z.stringbool().default(false),
		runs: z.coerce.number().int().min(1).max(12).default(6),
	})
	.strict()
export type ListRepeatOrdersQuery = z.infer<typeof listRepeatOrdersQuerySchema>

export const repeatOrderRunViewSchema = z.object({
	deliveryDate: isoDateSchema,
	cutoffDate: isoDateSchema,
	cutoffTime: z.string(),
	status: z.enum(['scheduled', ...REPEAT_ORDER_RUN_STATUSES]),
	orderId: z.string().nullable(),
	note: z.string().nullable(),
})
export type RepeatOrderRunView = z.infer<typeof repeatOrderRunViewSchema>

export const repeatOrderSummarySchema = z.object({
	id: z.string(),
	locationId: z.string(),
	supplierId: z.string(),
	supplierName: z.string(),
	supplierPaused: z.boolean(),
	supplierArchived: z.boolean(),
	sourceOrderId: z.string().nullable(),
	cadenceWeeks: cadenceWeeksSchema,
	weekdays: z.array(weekdaySchema),
	mode: z.enum(REPEAT_ORDER_MODES),
	anchorDate: isoDateSchema,
	linesCount: z.number().int().nonnegative(),
	note: z.string().nullable(),
	status: z.enum(REPEAT_ORDER_STATUSES),
	effectiveStatus: z.enum(REPEAT_ORDER_EFFECTIVE_STATUSES),
	version: z.number().int(),
	upcomingRuns: z.array(repeatOrderRunViewSchema),
})
export type RepeatOrderSummary = z.infer<typeof repeatOrderSummarySchema>

export const listRepeatOrdersResultSchema = z.object({
	repeatOrders: z.array(repeatOrderSummarySchema),
})
export type ListRepeatOrdersResult = z.infer<
	typeof listRepeatOrdersResultSchema
>

// ── Pure schedule, cut-off & holiday helpers ────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function momentToEpochMinutes(moment: LocalMoment): number {
	const [y, m, d] = moment.date.split('-').map(Number)
	const match = HHMM_RE.exec(moment.time)
	const hh = match ? Number(match[1]) : 0
	const mm = match ? Number(match[2]) : 0
	return Math.floor(Date.UTC(y!, m! - 1, d!) / 60_000) + hh * 60 + mm
}

function daysBetweenIso(from: string, to: string): number {
	const [fy, fm, fd] = from.split('-').map(Number)
	const [ty, tm, td] = to.split('-').map(Number)
	return Math.round(
		(Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / 86_400_000,
	)
}

/**
 * Cut-off moment for a repeat-order delivery date.
 * Uses the supplier's schedule when configured; if `cutoffTime` is absent,
 * defaults to `16:00` local time, 1 day before delivery.
 */
export function repeatOrderCutoffFor(
	deliveryDate: string,
	schedule: Pick<SupplierSchedule, 'cutoffTime' | 'cutoffDaysBefore'>,
): LocalMoment {
	if (schedule.cutoffTime) {
		return orderCutoffFor(deliveryDate, schedule)
	}
	return {
		date: addDaysIso(
			deliveryDate,
			-(schedule.cutoffDaysBefore ?? DEFAULT_REPEAT_CUTOFF_DAYS_BEFORE),
		),
		time: DEFAULT_REPEAT_CUTOFF_TIME,
	}
}

/**
 * True when `now` is within `leadMinutes` before `cutoff` and has not passed
 * `cutoff` (inclusive of both boundaries).
 */
export function isWithinDraftWindow(
	cutoff: LocalMoment,
	now: LocalMoment,
	leadMinutes = REPEAT_DRAFT_LEAD_MINUTES,
): boolean {
	const cutoffMin = momentToEpochMinutes(cutoff)
	const nowMin = momentToEpochMinutes(now)
	return nowMin >= cutoffMin - leadMinutes && nowMin <= cutoffMin
}

/**
 * True when `deliveryDate` falls on one of `weekdays` and on the `cadenceWeeks`
 * rhythm starting at `anchorDate`'s week (Sunday-aligned).
 */
export function isCadenceMatch(
	deliveryDate: string,
	anchorDate: string,
	cadenceWeeks: RepeatOrderCadenceWeeks,
	weekdays: readonly number[],
): boolean {
	if (weekdays.length === 0) return false
	if (deliveryDate < anchorDate) return false
	if (!weekdays.includes(weekdayOf(deliveryDate))) return false
	if (cadenceWeeks === 1) return true
	const anchorWeekStart = addDaysIso(anchorDate, -weekdayOf(anchorDate))
	const targetWeekStart = addDaysIso(deliveryDate, -weekdayOf(deliveryDate))
	const weeksDiff = Math.round(
		daysBetweenIso(anchorWeekStart, targetWeekStart) / 7,
	)
	return weeksDiff >= 0 && weeksDiff % cadenceWeeks === 0
}

/**
 * Returns the next `count` scheduled delivery dates on or after `fromDate`.
 */
export function upcomingRepeatDeliveryDates(input: {
	fromDate: string
	cadenceWeeks: RepeatOrderCadenceWeeks
	weekdays: readonly number[]
	anchorDate: string
	count?: number
	maxLookaheadDays?: number
}): string[] {
	const count = input.count ?? DEFAULT_UPCOMING_RUNS_COUNT
	const maxLookahead = input.maxLookaheadDays ?? 120
	if (input.weekdays.length === 0 || count <= 0) return []
	const out: string[] = []
	for (let offset = 0; offset <= maxLookahead && out.length < count; offset++) {
		const date = addDaysIso(input.fromDate, offset)
		if (
			isCadenceMatch(date, input.anchorDate, input.cadenceWeeks, input.weekdays)
		) {
			out.push(date)
		}
	}
	return out
}

/**
 * Finds the next scheduled delivery date whose cut-off is currently inside the
 * pre-cutoff draft window at `now`.
 */
export function findDueRepeatDeliveryDate(input: {
	now: LocalMoment
	cadenceWeeks: RepeatOrderCadenceWeeks
	weekdays: readonly number[]
	anchorDate: string
	schedule: Pick<SupplierSchedule, 'cutoffTime' | 'cutoffDaysBefore'>
	leadMinutes?: number
}): { deliveryDate: string; cutoff: LocalMoment } | null {
	if (input.weekdays.length === 0) return null
	const maxDays =
		(input.schedule.cutoffDaysBefore ?? DEFAULT_REPEAT_CUTOFF_DAYS_BEFORE) +
		Math.ceil((input.leadMinutes ?? REPEAT_DRAFT_LEAD_MINUTES) / 1440) +
		1
	for (let offset = 0; offset <= maxDays; offset++) {
		const deliveryDate = addDaysIso(input.now.date, offset)
		if (
			!isCadenceMatch(
				deliveryDate,
				input.anchorDate,
				input.cadenceWeeks,
				input.weekdays,
			)
		) {
			continue
		}
		const cutoff = repeatOrderCutoffFor(deliveryDate, input.schedule)
		if (isWithinDraftWindow(cutoff, input.now, input.leadMinutes)) {
			return { deliveryDate, cutoff }
		}
	}
	return null
}

/**
 * Extracts closed dates (`YYYY-MM-DD` → optional reason/note) from
 * `inv_location_settings.special_hours` or `rsv_location_settings.special_hours`.
 * Supports both `{ date, isOpen: false, note? }` (`parseSpecialHours`) and
 * `{ date, closed: true, reason?, note? }`.
 */
export function parseClosedSpecialDates(
	raw: unknown,
	/**
	 * Entries that repeat every year (#242) are expanded over this date range
	 * (`YYYY-MM-DD`, inclusive). Without a range only the dates written down
	 * count.
	 */
	range?: { from: string; to: string },
): Map<string, string | null> {
	const closed = new Map<string, string | null>()
	if (!raw) return closed
	let parsed: unknown = raw
	if (typeof raw === 'string') {
		const trimmed = raw.trim()
		if (!trimmed) return closed
		try {
			parsed = JSON.parse(trimmed)
		} catch {
			return closed
		}
	}
	if (!Array.isArray(parsed)) return closed
	const entries = range
		? expandSpecialHours(
				parsed.filter(
					(entry): entry is { date: string; repeatsYearly?: boolean } =>
						Boolean(entry) &&
						typeof entry === 'object' &&
						typeof (entry as { date?: unknown }).date === 'string',
				),
				range.from,
				range.to,
			)
		: parsed
	for (const entry of entries) {
		if (!entry || typeof entry !== 'object') continue
		const record = entry as Record<string, unknown>
		if (typeof record.date !== 'string' || !ISO_DATE_RE.test(record.date)) {
			continue
		}
		const isClosed = record.isOpen === false || record.closed === true
		if (!isClosed) continue
		const note =
			typeof record.note === 'string' && record.note.trim()
				? record.note.trim()
				: typeof record.reason === 'string' && record.reason.trim()
					? record.reason.trim()
					: null
		closed.set(record.date, note)
	}
	return closed
}

export function formatHolidaySkipNote(reason: string | null): string {
	return reason
		? `Skipped: closed for holiday (${reason})`
		: 'Skipped: closed for holiday'
}
