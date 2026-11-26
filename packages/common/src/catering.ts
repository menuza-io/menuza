import { z } from 'zod'
import {
	addDays,
	formatDate,
	isValidTimeZone,
	localParts,
	parseDate,
	startOfLocalDay,
	zonedLocalToUtc,
} from '@repo/zoned-time'
import { currencyExponent } from './money.ts'
import { type LocalizedString, pickLocalized } from './site-locales.ts'

/**
 * Catering: orders placed days ahead with lead times and limits, quotes the
 * guest pays online, order-by cutoffs for holiday dates, a deposit with a
 * balance link and reminders, and the "Good to know" answers (#124, #255,
 * #361, #325). Pure domain code shared by App, tenant-api, Sites and the
 * phone agent: schemas, date and window rules, money math, the quote state
 * machine and the answers. No I/O, no UI strings beyond the English defaults.
 *
 * Where the data lives: the settings are business configuration in the
 * control plane (`OrganizationLocation.catering`) and reach the region in the
 * order context; quotes, balances and guest contact are regional only.
 */

export const CATERING_CONTRACT_VERSION = 1

/** Org flags (default off, only a literal `true`; `quotes` needs `enabled`). */
export const CATERING_FLAG_KEYS = {
	enabled: 'catering.enabled',
	quotes: 'catering.quotes',
} as const

export const MAX_CATERING_CUTOFFS = 24
export const MAX_CATERING_ALERT_USERS = 25
export const MAX_CATERING_CUSTOM_QUESTIONS = 12
export const CATERING_NOTES_MAX_LENGTH = 500
export const CATERING_QUOTE_NOTE_MAX_LENGTH = 1000
export const CATERING_MAX_QUOTE_LINES = 100
export const CATERING_MAX_QUOTE_CHARGES = 10
export const CATERING_MAX_GUESTS_LIMIT = 5000
/** A quote can stay open at most this long (days after it is sent). */
export const CATERING_MAX_QUOTE_VALID_DAYS = 90
export const CATERING_DEFAULT_QUOTE_VALID_DAYS = 7

// ---------------------------------------------------------------------------
// Error codes (HTTP status chosen by the caller)
// ---------------------------------------------------------------------------

export const CATERING_ERROR_CODES = [
	'catering_disabled',
	'catering_unavailable',
	'catering_quotes_off',
	'catering_quote_required',
	'catering_event_required',
	'catering_too_soon',
	'catering_too_far',
	'catering_closed',
	'catering_minimum',
	'catering_maximum',
	'catering_guests',
	'catering_fulfillment',
	'catering_menu',
	'catering_cutoff_passed',
	'catering_gift_card',
	'catering_payment_required',
	'quote_not_found',
	'quote_expired',
	'quote_not_payable',
	'quote_not_editable',
	'quote_cancelled',
	'invalid_quote_token',
	'stale_version',
	'balance_not_due',
	'balance_not_found',
	'balance_already_paid',
	'balance_voided',
	'invalid_balance_token',
	'order_not_catering',
	'order_locked',
] as const
export type CateringErrorCode = (typeof CATERING_ERROR_CODES)[number]

export type CateringFailure = {
	code: CateringErrorCode
	message: string
	/** Machine-readable context (never personal data). */
	details?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Settings (control plane JSON: OrganizationLocation.catering)
// ---------------------------------------------------------------------------

export const CATERING_QUOTE_MODES = ['off', 'optional', 'required'] as const
export type CateringQuoteMode = (typeof CATERING_QUOTE_MODES)[number]

/** The standard questions, in the order guests see them. */
export const CATERING_STANDARD_QUESTION_IDS = [
	'cutlery',
	'dietary',
	'staff',
	'notice',
	'minimum',
	'delivery',
	'deposit',
] as const
export type CateringStandardQuestionId =
	(typeof CATERING_STANDARD_QUESTION_IDS)[number]

/** Answers typed by the restaurant. The rest are read from the settings. */
export const CATERING_TYPED_QUESTION_IDS = [
	'cutlery',
	'dietary',
	'staff',
] as const
/** `deposit` also takes a typed cancellation note, appended to the setting-backed part. */
export const CATERING_CANCELLATION_QUESTION_ID = 'deposit' as const

const localizedTextSchema = z.record(z.string(), z.string().trim().max(500))

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const cateringCutoffSchema = z
	.strictObject({
		id: z.string().min(1).max(64),
		/** Event date range (inclusive), the guest's pickup or delivery date. */
		from: isoDate,
		to: isoDate,
		/** The order-by moment, a wall clock in the location's time zone. */
		orderByDate: isoDate,
		orderByTime: hhmm,
		note: localizedTextSchema.nullable().optional(),
	})
	.superRefine((cutoff, ctx) => {
		if (cutoff.to < cutoff.from) {
			ctx.addIssue({
				code: 'custom',
				path: ['to'],
				message: 'The range cannot end before it starts.',
			})
		}
		// Both are wall clocks in the same zone, so comparing the dates is
		// enough: the moment must be before the first event day begins.
		if (cutoff.orderByDate >= cutoff.from) {
			ctx.addIssue({
				code: 'custom',
				path: ['orderByDate'],
				message: 'Order by must be before the range starts.',
			})
		}
	})
export type CateringCutoff = z.infer<typeof cateringCutoffSchema>

const questionAnswerSchema = localizedTextSchema.nullable()

export const cateringSettingsSchema = z.strictObject({
	version: z.literal(1).default(1),
	enabled: z.boolean().default(false),
	/** Minimum notice in hours before the event time. */
	noticeHours: z
		.number()
		.int()
		.min(0)
		.max(24 * 60)
		.default(24),
	/** How far ahead guests can order, in days. */
	maxDaysAhead: z.number().int().min(1).max(365).default(60),
	/** Minimum and maximum order amount (items and charges before tax), minor units. */
	minMinor: z.number().int().min(0).max(100_000_000).nullable().default(null),
	maxMinor: z.number().int().min(1).max(1_000_000_000).nullable().default(null),
	maxGuests: z
		.number()
		.int()
		.min(1)
		.max(CATERING_MAX_GUESTS_LIMIT)
		.nullable()
		.default(null),
	fulfillments: z
		.strictObject({ pickup: z.boolean(), delivery: z.boolean() })
		.default({ pickup: true, delivery: false }),
	quoteMode: z.enum(CATERING_QUOTE_MODES).default('off'),
	/** Members told about a new request or order (user ids; no guest data ever). */
	alertUserIds: z
		.array(z.string().min(1).max(64))
		.max(MAX_CATERING_ALERT_USERS)
		.default([]),
	cutoffs: z.array(cateringCutoffSchema).max(MAX_CATERING_CUTOFFS).default([]),
	deposit: z
		.strictObject({
			/** Percent of the order total taken at checkout; 0 means pay in full. */
			percent: z.number().int().min(0).max(100).default(0),
			/** The balance is due this many days before the event. */
			balanceDueDaysBeforeEvent: z.number().int().min(0).max(60).default(3),
			/** One reminder this many days before the balance is due (0 is off). */
			reminderDaysBeforeDue: z.number().int().min(0).max(14).default(2),
			/** Free text appended to the deposit and cancellation answer. */
			cancellationNote: questionAnswerSchema.optional(),
		})
		.default({
			percent: 0,
			balanceDueDaysBeforeEvent: 3,
			reminderDaysBeforeDue: 2,
		}),
	questions: z
		.strictObject({
			/** Typed answers to the standard questions (`CATERING_TYPED_QUESTION_IDS`). */
			standard: z
				.partialRecord(
					z.enum(CATERING_TYPED_QUESTION_IDS),
					questionAnswerSchema,
				)
				.default({}),
			custom: z
				.array(
					z.strictObject({
						id: z.string().min(1).max(64),
						question: localizedTextSchema,
						answer: localizedTextSchema,
					}),
				)
				.max(MAX_CATERING_CUSTOM_QUESTIONS)
				.default([]),
		})
		.default({ standard: {}, custom: [] }),
})
export type CateringSettings = z.infer<typeof cateringSettingsSchema>

export function defaultCateringSettings(): CateringSettings {
	return cateringSettingsSchema.parse({})
}

/** Parses stored JSON (or an object); null when missing or unreadable. */
export function parseCateringSettings(raw: unknown): CateringSettings | null {
	if (raw == null || raw === '') return null
	let candidate: unknown = raw
	if (typeof candidate === 'string') {
		try {
			candidate = JSON.parse(candidate)
		} catch {
			return null
		}
	}
	const parsed = cateringSettingsSchema.safeParse(candidate)
	return parsed.success ? parsed.data : null
}

/**
 * Cross-field checks for saving: the min below the max, at least one
 * fulfillment, a quote mode that needs the quote flag, ranges not in the past
 * and no more than 24 cutoffs. Returns messages (empty when valid).
 */
export function validateCateringSettings(
	settings: CateringSettings,
	options: { timeZone: string; now: Date; quotesFlag: boolean },
): string[] {
	const problems: string[] = []
	if (
		settings.minMinor != null &&
		settings.maxMinor != null &&
		settings.minMinor > settings.maxMinor
	) {
		problems.push('The minimum order cannot be more than the maximum.')
	}
	if (!settings.fulfillments.pickup && !settings.fulfillments.delivery) {
		problems.push('Allow pickup, delivery or both.')
	}
	if (settings.quoteMode !== 'off' && !options.quotesFlag) {
		problems.push('Quotes are not turned on for this organization.')
	}
	if (isValidTimeZone(options.timeZone)) {
		const today = localDateOf(options.now.getTime(), options.timeZone)
		for (const cutoff of settings.cutoffs) {
			if (cutoff.to < today) {
				problems.push('A range cannot end in the past.')
				break
			}
		}
	}
	return problems
}

// ---------------------------------------------------------------------------
// Order context (what the region reads)
// ---------------------------------------------------------------------------

export type CateringLocationPolicy = {
	enabled: boolean
	quotes: boolean
	settings: CateringSettings
}

/**
 * The context the App sends the region (`catering` in the order context):
 * only while the org flag is on, one entry per location that turned catering
 * on. Read with {@link readCateringPolicy}: missing or bad is off.
 */
export type CateringContext = {
	version: number
	quotes: boolean
	locations: Record<string, unknown>
}

export function readCateringPolicy(
	raw: unknown,
	locationId: string,
): CateringLocationPolicy | null {
	if (!raw || typeof raw !== 'object') return null
	const ctx = raw as Partial<CateringContext>
	const entry = ctx.locations?.[locationId]
	const settings = parseCateringSettings(entry)
	if (!settings || !settings.enabled) return null
	return {
		enabled: true,
		// A quote mode needs the child flag: without it the page asks for payment.
		quotes: ctx.quotes === true && settings.quoteMode !== 'off',
		settings:
			ctx.quotes === true
				? settings
				: { ...settings, quoteMode: 'off' as const },
	}
}

// ---------------------------------------------------------------------------
// Dates, cutoffs and the booking window
// ---------------------------------------------------------------------------

const MS_HOUR = 60 * 60 * 1000
const MS_DAY = 24 * MS_HOUR

function toMs(value: Date | number): number {
	return typeof value === 'number' ? value : value.getTime()
}

/** `YYYY-MM-DD` of an instant in a zone (the event date, never the browser's). */
export function localDateOf(ms: number, timeZone: string): string {
	const p = localParts(ms, timeZone)
	return formatDate(p.year, p.month, p.day)
}

/** The instant a cutoff's order-by wall clock falls on in the location's zone. */
export function cutoffOrderByMs(
	cutoff: Pick<CateringCutoff, 'orderByDate' | 'orderByTime'>,
	timeZone: string,
): number {
	const { year, month, day } = parseDate(cutoff.orderByDate)
	const [hour, minute] = cutoff.orderByTime.split(':').map(Number) as [
		number,
		number,
	]
	return zonedLocalToUtc(year, month, day, hour, minute, timeZone)
}

export type CateringCutoffView = {
	id: string
	from: string
	to: string
	orderByDate: string
	orderByTime: string
	/** The order-by instant (epoch ms), resolved in the location's zone. */
	orderByAtMs: number
	note: LocalizedString | null
	/** True once the order-by moment has passed. */
	closed: boolean
}

function cutoffView(
	cutoff: CateringCutoff,
	timeZone: string,
	nowMs: number,
): CateringCutoffView {
	const orderByAtMs = cutoffOrderByMs(cutoff, timeZone)
	return {
		id: cutoff.id,
		from: cutoff.from,
		to: cutoff.to,
		orderByDate: cutoff.orderByDate,
		orderByTime: cutoff.orderByTime,
		orderByAtMs,
		note: (cutoff.note as LocalizedString | null | undefined) ?? null,
		closed: nowMs >= orderByAtMs,
	}
}

/**
 * Cutoffs still worth listing: a cutoff whose range has ended is archived
 * automatically (nothing is deleted, readers just stop showing it).
 */
export function activeCateringCutoffs(
	settings: Pick<CateringSettings, 'cutoffs'>,
	now: Date | number,
	timeZone: string,
): CateringCutoffView[] {
	const nowMs = toMs(now)
	const today = localDateOf(nowMs, timeZone)
	return settings.cutoffs
		.filter((cutoff) => cutoff.to >= today)
		.map((cutoff) => cutoffView(cutoff, timeZone, nowMs))
		.sort(
			(a, b) => a.from.localeCompare(b.from) || a.orderByAtMs - b.orderByAtMs,
		)
}

export type CateringDateStatus =
	| {
			orderable: true
			/** The earliest order-by moment still ahead for this date, to show the guest. */
			orderBy: CateringCutoffView | null
	  }
	| { orderable: false; cutoff: CateringCutoffView }

/**
 * Whether a calendar date (the pickup or delivery date, in the location's
 * zone) can still be ordered. Overlapping ranges: the earliest order-by
 * moment wins, so a date is closed as soon as any covering cutoff has passed.
 */
export function cateringDateStatus(
	settings: Pick<CateringSettings, 'cutoffs'>,
	now: Date | number,
	date: string,
	timeZone: string,
): CateringDateStatus {
	const nowMs = toMs(now)
	const covering = settings.cutoffs
		.filter((cutoff) => cutoff.from <= date && date <= cutoff.to)
		.map((cutoff) => cutoffView(cutoff, timeZone, nowMs))
		.sort((a, b) => a.orderByAtMs - b.orderByAtMs)
	const earliest = covering[0]
	if (!earliest) return { orderable: true, orderBy: null }
	if (earliest.closed) return { orderable: false, cutoff: earliest }
	return { orderable: true, orderBy: earliest }
}

/**
 * The one rule Sites (the picker), tenant-api (placing and quoting) and the
 * phone agent share: can an event at `eventAt` still be ordered, given the
 * cutoffs, the time now and the location's zone. A cutoff applies to the
 * event date, never to the day the guest orders, and never to an order
 * already placed or a quote already sent (those are not re-checked).
 */
export function isCateringDateOrderable(
	settings: Pick<CateringSettings, 'cutoffs'> & { timeZone: string },
	now: Date | number,
	eventAt: Date | number,
): CateringDateStatus {
	return cateringDateStatus(
		settings,
		now,
		localDateOf(toMs(eventAt), settings.timeZone),
		settings.timeZone,
	)
}

export type CateringWindowLocation = {
	timezone?: string | null
}

export type CateringWindowOpenCheck = (eventAt: Date) => {
	isOpen: boolean
	reason?: string | null
}

/**
 * Notice, how far ahead, the cutoffs and opening hours for an event time.
 * `isOpenAt` answers whether the location takes online orders at that
 * instant: callers pass `isLocationOpenForOrdering` with the ordering pause
 * and busy mode stripped (neither blocks catering for a future day).
 */
export function validateCateringEvent(input: {
	settings: CateringSettings
	timeZone: string
	eventAt: Date
	now: Date
	isOpenAt?: CateringWindowOpenCheck
}): { ok: true } | { ok: false; failure: CateringFailure } {
	const { settings, eventAt, now } = input
	const timeZone = isValidTimeZone(input.timeZone) ? input.timeZone : 'UTC'
	const fail = (
		code: CateringErrorCode,
		message: string,
		details?: Record<string, unknown>,
	) => ({
		ok: false as const,
		failure: { code, message, ...(details ? { details } : {}) },
	})
	if (Number.isNaN(eventAt.getTime())) {
		return fail('catering_event_required', 'Choose a date and time.')
	}
	const earliest = now.getTime() + settings.noticeHours * MS_HOUR
	if (eventAt.getTime() < earliest) {
		return fail(
			'catering_too_soon',
			`Catering orders need at least ${settings.noticeHours} hours' notice.`,
			{ noticeHours: settings.noticeHours },
		)
	}
	if (eventAt.getTime() > now.getTime() + settings.maxDaysAhead * MS_DAY) {
		return fail(
			'catering_too_far',
			`Catering orders can be placed up to ${settings.maxDaysAhead} days ahead.`,
			{ maxDaysAhead: settings.maxDaysAhead },
		)
	}
	const dateStatus = isCateringDateOrderable(
		{ cutoffs: settings.cutoffs, timeZone },
		now,
		eventAt,
	)
	if (!dateStatus.orderable) {
		return fail('catering_cutoff_passed', 'Orders for that date have closed.', {
			from: dateStatus.cutoff.from,
			to: dateStatus.cutoff.to,
			orderByAtMs: dateStatus.cutoff.orderByAtMs,
		})
	}
	if (input.isOpenAt) {
		const open = input.isOpenAt(eventAt)
		if (!open.isOpen) {
			return fail(
				'catering_closed',
				open.reason || 'The restaurant is not taking orders at that time.',
			)
		}
	}
	return { ok: true }
}

/** The amount, guest count and fulfillment limits of a catering order or quote. */
export function checkCateringLimits(input: {
	settings: CateringSettings
	/** Items and charges before tax, discounts and tip, minor units. */
	subtotalCents: number
	guestCount: number | null | undefined
	fulfillment: 'pickup' | 'delivery'
}): { ok: true } | { ok: false; failure: CateringFailure } {
	const { settings } = input
	const fail = (
		code: CateringErrorCode,
		message: string,
		details?: Record<string, unknown>,
	) => ({
		ok: false as const,
		failure: { code, message, ...(details ? { details } : {}) },
	})
	if (!settings.fulfillments[input.fulfillment]) {
		return fail(
			'catering_fulfillment',
			input.fulfillment === 'delivery'
				? 'Catering delivery is not available here.'
				: 'Catering pickup is not available here.',
		)
	}
	if (settings.minMinor != null && input.subtotalCents < settings.minMinor) {
		return fail(
			'catering_minimum',
			'This order is below the catering minimum.',
			{
				minMinor: settings.minMinor,
			},
		)
	}
	if (settings.maxMinor != null && input.subtotalCents > settings.maxMinor) {
		return fail(
			'catering_maximum',
			'This order is above the catering maximum.',
			{
				maxMinor: settings.maxMinor,
			},
		)
	}
	if (
		settings.maxGuests != null &&
		input.guestCount != null &&
		input.guestCount > settings.maxGuests
	) {
		return fail('catering_guests', 'This group is larger than we can cater.', {
			maxGuests: settings.maxGuests,
		})
	}
	return { ok: true }
}

// ---------------------------------------------------------------------------
// Deposit, balance and reminders (#361)
// ---------------------------------------------------------------------------

/**
 * Splits a total into the deposit taken at checkout and the balance due
 * later. 0 percent (or 100) means pay in full: no balance. The deposit is
 * rounded to the nearest minor unit, at least 1 and never more than the total.
 */
export function computeDepositSplit(input: {
	totalCents: number
	percent: number | null | undefined
}): { depositCents: number; balanceCents: number; percent: number } {
	const total = Math.max(0, Math.round(input.totalCents))
	const percent = Math.max(0, Math.min(100, Math.round(input.percent ?? 0)))
	if (percent <= 0 || percent >= 100 || total <= 1) {
		return { depositCents: total, balanceCents: 0, percent: 100 }
	}
	const depositCents = Math.min(
		total - 1,
		Math.max(1, Math.round((total * percent) / 100)),
	)
	return { depositCents, balanceCents: total - depositCents, percent }
}

/**
 * The instant the balance falls due: the end of the local day that is
 * `daysBefore` days before the event date, in the location's zone.
 */
export function balanceDueAtMs(
	eventAt: Date | number,
	daysBefore: number,
	timeZone: string,
): number {
	const eventDate = localDateOf(toMs(eventAt), timeZone)
	return startOfLocalDay(addDays(eventDate, -daysBefore + 1), timeZone)
}

/** The calendar date shown as the due date (the due instant is the end of that day). */
export function balanceDueDate(dueAtMs: number, timeZone: string): string {
	return localDateOf(dueAtMs - 1, timeZone)
}

/** The instant for a due date typed by an operator (the end of that local day). */
export function dueAtForDate(date: string, timeZone: string): number {
	return startOfLocalDay(addDays(date, 1), timeZone)
}

/** Guests are not messaged between 21:00 and 08:00 in the location's zone. */
export const CATERING_QUIET_START_HOUR = 21
export const CATERING_QUIET_END_HOUR = 8

export function inCateringQuietHours(ms: number, timeZone: string): boolean {
	const hour = localParts(ms, timeZone).hour
	return hour >= CATERING_QUIET_START_HOUR || hour < CATERING_QUIET_END_HOUR
}

/** The first instant at or after `ms` outside the quiet hours. */
export function nextCateringSendWindowMs(ms: number, timeZone: string): number {
	if (!inCateringQuietHours(ms, timeZone)) return ms
	const date = localDateOf(ms, timeZone)
	const p = localParts(ms, timeZone)
	const targetDate =
		p.hour >= CATERING_QUIET_START_HOUR ? addDays(date, 1) : date
	const { year, month, day } = parseDate(targetDate)
	return zonedLocalToUtc(year, month, day, CATERING_QUIET_END_HOUR, 0, timeZone)
}

export type BalanceReminderKind = 'before_due' | 'overdue'

export type BalanceReminderState = {
	balanceDueAtMs: number | null
	balanceCents: number
	balanceState: 'due' | 'paid' | 'void' | null
	beforeDueSentAtMs: number | null
	overdueSentAtMs: number | null
	eventAtMs: number
}

/**
 * Which balance reminder is due now (the tick sends it once), and when the
 * next one will be (to wake the tick). A paid or voided balance sends none.
 */
export function nextBalanceReminder(
	state: BalanceReminderState,
	options: { now: number; timeZone: string; reminderDaysBeforeDue: number },
): { due: BalanceReminderKind | null; nextAtMs: number | null } {
	if (
		state.balanceState !== 'due' ||
		state.balanceDueAtMs == null ||
		state.balanceCents <= 0
	) {
		return { due: null, nextAtMs: null }
	}
	const { now, timeZone } = options
	const dueAt = state.balanceDueAtMs
	const candidates: Array<{ kind: BalanceReminderKind; at: number }> = []
	if (options.reminderDaysBeforeDue > 0 && state.beforeDueSentAtMs == null) {
		const dueDate = balanceDueDate(dueAt, timeZone)
		const startOfReminderDay = startOfLocalDay(
			addDays(dueDate, -options.reminderDaysBeforeDue),
			timeZone,
		)
		candidates.push({ kind: 'before_due', at: startOfReminderDay })
	}
	if (state.overdueSentAtMs == null) {
		candidates.push({ kind: 'overdue', at: dueAt })
	}
	const open = candidates
		.map((candidate) => ({
			...candidate,
			at: nextCateringSendWindowMs(candidate.at, timeZone),
		}))
		.sort((a, b) => a.at - b.at)
	if (open.length === 0) return { due: null, nextAtMs: null }
	// Once the overdue moment has passed the "before due" reminder is moot.
	const overdueReached = now >= dueAt
	const ready = open.filter(
		(candidate) =>
			candidate.at <= now &&
			!(overdueReached && candidate.kind === 'before_due'),
	)
	const pick =
		ready.find((candidate) => candidate.kind === 'overdue') ?? ready[0]
	if (pick) return { due: pick.kind, nextAtMs: null }
	const upcoming = open.find((candidate) => candidate.at > now)
	return { due: null, nextAtMs: upcoming?.at ?? null }
}

/**
 * The restaurant's reminder the day before a catering event: from 09:00 local
 * on the day before the event date, until the event.
 */
export function eventDayBeforeAlertAtMs(
	eventAt: Date | number,
	timeZone: string,
): number {
	const eventDate = localDateOf(toMs(eventAt), timeZone)
	const { year, month, day } = parseDate(addDays(eventDate, -1))
	return zonedLocalToUtc(year, month, day, 9, 0, timeZone)
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export const CATERING_QUOTE_STATUSES = [
	'draft',
	'sent',
	'accepted',
	'paid',
	'expired',
	'cancelled',
] as const
export type CateringQuoteStatus = (typeof CATERING_QUOTE_STATUSES)[number]

/** Order refs the payment bridge understands. Ids are UUIDs, never contain a colon. */
export const QUOTE_REF_PREFIX = 'quote:'
export const BALANCE_REF_PREFIX = 'bal:'

export function quoteOrderRef(quoteId: string): string {
	return `${QUOTE_REF_PREFIX}${quoteId}`
}
export function balanceOrderRef(orderId: string): string {
	return `${BALANCE_REF_PREFIX}${orderId}`
}
export function parseQuoteOrderRef(ref: string): string | null {
	if (!ref.startsWith(QUOTE_REF_PREFIX)) return null
	const id = ref.slice(QUOTE_REF_PREFIX.length)
	return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null
}
export function parseBalanceOrderRef(ref: string): string | null {
	if (!ref.startsWith(BALANCE_REF_PREFIX)) return null
	const id = ref.slice(BALANCE_REF_PREFIX.length)
	return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null
}

/** HMAC purposes of the capability links (carried in the URL fragment, never stored). */
export const CATERING_QUOTE_TOKEN_PURPOSE = 'catering-quote:v1'
export const CATERING_BALANCE_TOKEN_PURPOSE = 'catering-balance:v1'
export const CATERING_QUOTE_TOKEN_HEADER = 'X-Quote-Token'
export const CATERING_BALANCE_TOKEN_HEADER = 'X-Balance-Token'

export const cateringQuoteOptionSchema = z.strictObject({
	groupName: z.string().max(120).optional(),
	optionName: z.string().max(200),
	priceCents: z.number().int().min(0).max(100_000_000),
	quantity: z.number().int().min(1).max(100).default(1),
})

/** A line as stored on a quote (and copied onto the order when paid). */
export const cateringQuoteLineSchema = z.strictObject({
	lineId: z.string().min(1).max(64),
	/** The menu dish, or null for an off-menu line the restaurant typed. */
	itemId: z.string().min(1).max(100).nullable(),
	itemName: z.string().trim().min(1).max(200),
	variantId: z.string().max(100).nullable().optional(),
	variantNames: z.array(z.string().max(120)).max(10).optional(),
	options: z.array(cateringQuoteOptionSchema).max(50).default([]),
	quantity: z.number().int().min(1).max(1000),
	/** What the guest pays per unit, options included. */
	unitPriceCents: z.number().int().min(0).max(100_000_000),
	taxable: z.boolean().default(true),
	instructions: z.string().trim().max(280).nullable().optional(),
	categoryIds: z.array(z.string().max(100)).max(20).default([]),
	menuId: z.string().max(100).optional(),
	menuName: z.string().max(200).optional(),
	categoryId: z.string().max(100).optional(),
	categoryName: z.string().max(200).optional(),
})
export type CateringQuoteLine = z.infer<typeof cateringQuoteLineSchema>

export const CATERING_CHARGE_KINDS = [
	'delivery',
	'setup',
	'service',
	'other',
] as const
export const cateringQuoteChargeSchema = z.strictObject({
	chargeId: z.string().min(1).max(64),
	kind: z.enum(CATERING_CHARGE_KINDS),
	label: z.string().trim().min(1).max(120),
	amountCents: z.number().int().min(0).max(100_000_000),
	taxable: z.boolean().default(false),
})
export type CateringQuoteCharge = z.infer<typeof cateringQuoteChargeSchema>

export type CateringQuoteTotals = {
	subtotalCents: number
	linesCents: number
	chargesCents: number
	taxCents: number
	taxInclusive: boolean
	totalCents: number
}

/**
 * Prices a quote: what the operator set, plus tax computed from the
 * location's tax settings (inclusive prices carry the tax; exclusive adds
 * it). Rounded once for the whole quote, like an order.
 */
export function priceCateringQuote(input: {
	lines: readonly Pick<
		CateringQuoteLine,
		'quantity' | 'unitPriceCents' | 'taxable'
	>[]
	charges: readonly Pick<CateringQuoteCharge, 'amountCents' | 'taxable'>[]
	taxRatePercent: number
	taxInclusive: boolean
}): CateringQuoteTotals {
	const linesCents = input.lines.reduce(
		(sum, line) => sum + line.quantity * line.unitPriceCents,
		0,
	)
	const chargesCents = input.charges.reduce(
		(sum, charge) => sum + charge.amountCents,
		0,
	)
	const taxable =
		input.lines.reduce(
			(sum, line) =>
				sum + (line.taxable ? line.quantity * line.unitPriceCents : 0),
			0,
		) +
		input.charges.reduce(
			(sum, charge) => sum + (charge.taxable ? charge.amountCents : 0),
			0,
		)
	const rate = Math.max(0, Math.min(100, input.taxRatePercent || 0))
	const taxCents = input.taxInclusive
		? rate > 0 && taxable > 0
			? Math.round((taxable * rate) / (100 + rate))
			: 0
		: Math.round((taxable * rate) / 100)
	const subtotalCents = linesCents + chargesCents
	return {
		subtotalCents,
		linesCents,
		chargesCents,
		taxCents,
		taxInclusive: input.taxInclusive,
		totalCents: subtotalCents + (input.taxInclusive ? 0 : taxCents),
	}
}

export function isQuoteExpired(
	quote: { expiresAtMs: number | null },
	now: number,
): boolean {
	return quote.expiresAtMs != null && quote.expiresAtMs <= now
}

/** Only a sent, unexpired quote can be paid (`quote_expired`, `quote_not_payable`). */
export function quotePayability(
	quote: { status: CateringQuoteStatus; expiresAtMs: number | null },
	now: number,
): { ok: true } | { ok: false; failure: CateringFailure } {
	if (quote.status === 'cancelled') {
		return {
			ok: false,
			failure: {
				code: 'quote_cancelled',
				message: 'This quote was cancelled.',
			},
		}
	}
	if (quote.status === 'expired' || isQuoteExpired(quote, now)) {
		return {
			ok: false,
			failure: { code: 'quote_expired', message: 'This quote has expired.' },
		}
	}
	if (quote.status !== 'sent' && quote.status !== 'accepted') {
		return {
			ok: false,
			failure: {
				code: 'quote_not_payable',
				message: 'This quote cannot be paid right now.',
			},
		}
	}
	return { ok: true }
}

export const CATERING_QUOTE_EDITABLE_STATUSES: readonly CateringQuoteStatus[] =
	['draft', 'sent']

// ---------------------------------------------------------------------------
// Request schemas (guest and operator)
// ---------------------------------------------------------------------------

const phone = z
	.string()
	.trim()
	.transform((value) => value.replace(/[\s\-().]/g, ''))
	.refine((value) => /^\+?\d{7,20}$/.test(value), {
		message: 'Enter a valid phone number',
	})

export const cateringContactSchema = z.strictObject({
	name: z.string().trim().min(1).max(120),
	phone,
	email: z.string().trim().email().max(254),
})

export const cateringDeliverySchema = z.strictObject({
	address: z.string().trim().min(5).max(200),
	city: z.string().trim().min(1).max(100),
	unit: z.string().trim().max(50).optional(),
	notes: z.string().trim().max(200).optional(),
})

/** What a guest sends with a catering order (the order's own `catering` key). */
export const cateringOrderInputSchema = z.strictObject({
	notes: z.string().trim().max(CATERING_NOTES_MAX_LENGTH).optional(),
})
export type CateringOrderInput = z.infer<typeof cateringOrderInputSchema>

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** `POST /catering/quote-requests`. */
export const cateringQuoteRequestSchema = z.strictObject({
	slug: z.string().trim().min(1).max(100).optional(),
	host: z.string().trim().min(1).max(253).optional(),
	idempotencyKey: z.string().regex(UUID_PATTERN),
	locale: z.string().trim().min(2).max(10).default('en'),
	locationId: z.string().min(1).max(100),
	fulfillment: z.enum(['pickup', 'delivery']),
	/** The event time, an ISO-8601 instant with an offset. */
	eventAt: z.string().datetime({ offset: true }).max(40),
	guestCount: z.number().int().min(1).max(CATERING_MAX_GUESTS_LIMIT),
	notes: z.string().trim().max(CATERING_NOTES_MAX_LENGTH).optional(),
	contact: cateringContactSchema,
	delivery: cateringDeliverySchema.optional(),
	lines: z
		.array(
			z.strictObject({
				itemId: z.string().min(1).max(100),
				variantId: z.string().min(1).max(100).optional(),
				quantity: z.number().int().min(1).max(1000),
				instructions: z.string().trim().max(280).optional(),
				options: z
					.array(
						z.strictObject({
							groupId: z.string().min(1).max(100),
							optionId: z.string().min(1).max(100),
							half: z.enum(['whole', 'left', 'right']).optional(),
							quantity: z.number().int().min(1).max(100).optional(),
						}),
					)
					.max(50)
					.default([]),
			}),
		)
		.min(1)
		.max(50),
	turnstileToken: z.string().min(1).max(2048).optional(),
})
export type CateringQuoteRequest = z.infer<typeof cateringQuoteRequestSchema>

const operatorLineInputSchema = z.strictObject({
	lineId: z.string().min(1).max(64).optional(),
	itemId: z.string().min(1).max(100).nullable().optional(),
	itemName: z.string().trim().min(1).max(200).optional(),
	quantity: z.number().int().min(1).max(1000),
	unitPriceCents: z.number().int().min(0).max(100_000_000).optional(),
	taxable: z.boolean().optional(),
	instructions: z.string().trim().max(280).nullable().optional(),
})

const operatorChargeInputSchema = cateringQuoteChargeSchema
	.omit({ chargeId: true })
	.extend({ chargeId: z.string().min(1).max(64).optional() })

/** `POST /operator/catering/quotes` (a phone enquiry) and `PATCH` (edit). */
export const operatorQuoteWriteSchema = z.strictObject({
	locationId: z.string().min(1).max(100).optional(),
	fulfillment: z.enum(['pickup', 'delivery']).optional(),
	eventAt: z.string().datetime({ offset: true }).max(40).optional(),
	guestCount: z.number().int().min(1).max(CATERING_MAX_GUESTS_LIMIT).optional(),
	contact: cateringContactSchema.partial().optional(),
	delivery: cateringDeliverySchema.nullable().optional(),
	notes: z.string().trim().max(CATERING_NOTES_MAX_LENGTH).nullable().optional(),
	/** The note the guest sees on the quote. */
	quoteNote: z
		.string()
		.trim()
		.max(CATERING_QUOTE_NOTE_MAX_LENGTH)
		.nullable()
		.optional(),
	lines: z
		.array(operatorLineInputSchema)
		.min(1)
		.max(CATERING_MAX_QUOTE_LINES)
		.optional(),
	charges: z
		.array(operatorChargeInputSchema)
		.max(CATERING_MAX_QUOTE_CHARGES)
		.optional(),
	/** Days the quote stays payable after it is sent (default 7). */
	validDays: z
		.number()
		.int()
		.min(1)
		.max(CATERING_MAX_QUOTE_VALID_DAYS)
		.optional(),
	/** Overrides the location's deposit percent for this quote; null follows the location. */
	depositPercent: z.number().int().min(0).max(100).nullable().optional(),
	expectedVersion: z.number().int().min(1).optional(),
})
export type OperatorQuoteWrite = z.infer<typeof operatorQuoteWriteSchema>

export const operatorBalanceActionSchema = z.discriminatedUnion('action', [
	z.strictObject({ action: z.literal('void') }),
	z.strictObject({ action: z.literal('reopen') }),
	z.strictObject({ action: z.literal('resend') }),
	z.strictObject({
		action: z.literal('set_due'),
		/** `YYYY-MM-DD`, the last day to pay. */
		dueDate: isoDate,
	}),
])
export type OperatorBalanceAction = z.infer<typeof operatorBalanceActionSchema>

// ---------------------------------------------------------------------------
// Alerts (ids and counts only; the App turns them into notifications)
// ---------------------------------------------------------------------------

export const CATERING_NOTIFY_PATH = '/resources/catering/notify'

export const CATERING_ALERT_KINDS = [
	'quote_request',
	'order_placed',
	'quote_paid',
	'balance_paid',
	'event_tomorrow',
	'balance_overdue',
] as const
export type CateringAlertKind = (typeof CATERING_ALERT_KINDS)[number]

/** `POST /resources/catering/notify`: ids and counts, never a name, phone, email, note or line. */
export const cateringNotifyEventSchema = z.strictObject({
	orgId: z.string().min(1).max(100),
	kind: z.enum(CATERING_ALERT_KINDS),
	locationId: z.string().min(1).max(100),
	/** The quote or order the event is about (an opaque id). */
	refId: z.string().min(1).max(100),
	count: z.number().int().min(1).max(1000).default(1),
})
export type CateringNotifyEvent = z.infer<typeof cateringNotifyEventSchema>

// ---------------------------------------------------------------------------
// "Good to know" answers (#325)
// ---------------------------------------------------------------------------

export const CATERING_QUESTION_LABELS: Record<
	CateringStandardQuestionId,
	string
> = {
	cutlery: 'Do you provide plates, napkins and cutlery?',
	dietary: 'Which dietary needs can you meet?',
	staff: 'Do you offer set-up and serving staff?',
	notice: 'How much notice do you need?',
	minimum: 'Is there a minimum order?',
	delivery: 'Do you deliver, and what does it cost?',
	deposit: 'Is a deposit required, and what is the cancellation policy?',
}

/** Facts about the location the setting-backed answers read. */
export type CateringAnswerFacts = {
	currency: string
	/** Names of the delivery zones that apply to catering (optional detail). */
	deliveryZoneNames?: string[]
	/** The lowest delivery fee across zones, minor units, when there is one. */
	deliveryFeeMinor?: number | null
}

/**
 * Sentences built from the settings. English by default; Sites passes its own
 * translations so a guest reads the answer in the site's language. The
 * answers are always built from the settings, never typed, so they cannot
 * drift when a setting changes.
 */
export type CateringPhrases = {
	notice: (hours: number) => string
	minimum: (input: {
		minText: string | null
		maxText: string | null
		maxGuests: number | null
	}) => string | null
	delivery: (input: {
		delivers: boolean
		pickup: boolean
		zones: string[]
		feeText: string | null
	}) => string
	deposit: (input: { percent: number; balanceDueDays: number }) => string | null
}

export function formatCateringMoney(
	minor: number,
	currency: string,
	locale = 'en',
): string {
	const exponent = currencyExponent(currency)
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
			minimumFractionDigits: exponent,
			maximumFractionDigits: exponent,
		}).format(minor / 10 ** exponent)
	} catch {
		return `${(minor / 10 ** exponent).toFixed(exponent)} ${currency}`
	}
}

export const englishCateringPhrases: CateringPhrases = {
	notice: (hours) =>
		hours === 1
			? 'We need at least 1 hour of notice.'
			: `We need at least ${hours} hours of notice.`,
	minimum: ({ minText, maxText, maxGuests }) => {
		const parts: string[] = []
		if (minText) parts.push(`The minimum catering order is ${minText}.`)
		if (maxText) parts.push(`The largest order we take online is ${maxText}.`)
		if (maxGuests) parts.push(`We cater for up to ${maxGuests} guests.`)
		return parts.length > 0 ? parts.join(' ') : null
	},
	delivery: ({ delivers, pickup, zones, feeText }) => {
		if (!delivers) return pickup ? 'Catering is for pickup only.' : ''
		const where = zones.length > 0 ? ` to ${zones.join(', ')}` : ''
		const fee = feeText ? ` Delivery from ${feeText}.` : ''
		return `We deliver catering orders${where}.${fee}${pickup ? ' Pickup is available too.' : ''}`
	},
	deposit: ({ percent, balanceDueDays }) =>
		percent > 0 && percent < 100
			? `We take a ${percent}% deposit when you order. The balance is due ${balanceDueDays} ${balanceDueDays === 1 ? 'day' : 'days'} before the event.`
			: null,
}

export type CateringQnAEntry = {
	id: string
	/** `standard` and `custom` are typed by the restaurant, `setting` is read from the settings. */
	source: 'typed' | 'setting' | 'custom'
	question: string
	answer: string
}

/**
 * The "Good to know" list for the catering page, catering checkout and the
 * phone agent: standard questions in order, then the restaurant's own.
 * Unanswered questions are left out. Plain text, localized with the same
 * fallback as menu copy.
 */
export function buildCateringQnA(
	settings: CateringSettings,
	options: {
		locale: string
		defaultLocale: string
		facts: CateringAnswerFacts
		phrases?: CateringPhrases
		/** Question labels per id; defaults to the English ones. */
		questionLabels?: Partial<Record<CateringStandardQuestionId, string>>
		moneyLocale?: string
	},
): CateringQnAEntry[] {
	const phrases = options.phrases ?? englishCateringPhrases
	const labels = { ...CATERING_QUESTION_LABELS, ...options.questionLabels }
	const pick = (value: LocalizedString | null | undefined) =>
		pickLocalized(value ?? null, options.locale, options.defaultLocale)
	const money = (minor: number | null | undefined) =>
		minor == null || minor <= 0
			? null
			: formatCateringMoney(
					minor,
					options.facts.currency,
					options.moneyLocale ?? 'en',
				)
	const entries: CateringQnAEntry[] = []
	const push = (
		id: string,
		source: CateringQnAEntry['source'],
		question: string,
		answer: string | null | undefined,
	) => {
		const text = (answer ?? '').trim()
		if (text) entries.push({ id, source, question, answer: text })
	}
	for (const id of CATERING_STANDARD_QUESTION_IDS) {
		const question = labels[id]
		switch (id) {
			case 'cutlery':
			case 'dietary':
			case 'staff':
				push(
					id,
					'typed',
					question,
					pick(settings.questions.standard[id] as LocalizedString | null),
				)
				break
			case 'notice':
				push(id, 'setting', question, phrases.notice(settings.noticeHours))
				break
			case 'minimum':
				push(
					id,
					'setting',
					question,
					phrases.minimum({
						minText: money(settings.minMinor),
						maxText: money(settings.maxMinor),
						maxGuests: settings.maxGuests,
					}),
				)
				break
			case 'delivery':
				push(
					id,
					'setting',
					question,
					phrases.delivery({
						delivers: settings.fulfillments.delivery,
						pickup: settings.fulfillments.pickup,
						zones: options.facts.deliveryZoneNames ?? [],
						feeText: money(options.facts.deliveryFeeMinor),
					}),
				)
				break
			case 'deposit': {
				const derived = phrases.deposit({
					percent: settings.deposit.percent,
					balanceDueDays: settings.deposit.balanceDueDaysBeforeEvent,
				})
				const typed = pick(
					settings.deposit.cancellationNote as LocalizedString | null,
				)
				push(
					id,
					derived ? 'setting' : 'typed',
					question,
					[derived, typed].filter(Boolean).join(' '),
				)
				break
			}
		}
	}
	for (const custom of settings.questions.custom) {
		push(
			custom.id,
			'custom',
			pick(custom.question as LocalizedString),
			pick(custom.answer as LocalizedString),
		)
	}
	return entries
}

/** schema.org FAQPage structured data for the catering page. */
export function cateringFaqJsonLd(
	entries: readonly CateringQnAEntry[],
): Record<string, unknown> | null {
	if (entries.length === 0) return null
	return {
		'@context': 'https://schema.org',
		'@type': 'FAQPage',
		mainEntity: entries.map((entry) => ({
			'@type': 'Question',
			name: entry.question,
			acceptedAnswer: { '@type': 'Answer', text: entry.answer },
		})),
	}
}

/** The answers as plain text for the phone agent's approved knowledge. */
export function cateringKnowledgeText(
	entries: readonly CateringQnAEntry[],
): string {
	return entries
		.map((entry) => `${entry.question}\n${entry.answer}`)
		.join('\n\n')
}

/** Short English line for an order-by moment (the Sites picker translates its own). */
export function describeCutoffMoment(
	cutoff: Pick<CateringCutoffView, 'orderByAtMs'>,
	timeZone: string,
	locale = 'en',
): string {
	try {
		return new Intl.DateTimeFormat(locale, {
			timeZone,
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		}).format(new Date(cutoff.orderByAtMs))
	} catch {
		return new Date(cutoff.orderByAtMs).toISOString()
	}
}

/**
 * An event's wall clock (`YYYY-MM-DD` and `HH:MM`) in the location's zone as an
 * instant, for the catering page's date and time pickers. Null for a value that
 * is not a real date and time.
 */
export function cateringEventInstantMs(
	date: string,
	time: string,
	timeZone: string,
): number | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
		return null
	}
	const { year, month, day } = parseDate(date)
	const [hour, minute] = time.split(':').map(Number) as [number, number]
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > 31 ||
		hour > 23 ||
		minute > 59
	) {
		return null
	}
	const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC'
	return zonedLocalToUtc(year, month, day, hour, minute, zone)
}

/** The local calendar date of `ms` in a zone plus `days`: the picker's first and last day. */
export function cateringDateIn(
	ms: number,
	timeZone: string,
	addDaysCount = 0,
): string {
	const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC'
	return addDays(localDateOf(ms, zone), addDaysCount)
}
