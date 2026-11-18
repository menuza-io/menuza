/**
 * The registry of location settings that can be copied between locations
 * (#125), compared and edited in bulk (#418), and given a chain default or a
 * lock (#417). It is the one place to add a setting: id, label, the columns it
 * lives in, how to read it into a canonical value, how to write a value back as
 * a column patch, and how to summarise it in plain words for a preview.
 *
 * Pure: no I/O. Values are JSON-able "canonical values" (parsed objects, never
 * the stored text), so two locations compare equal when they behave the same,
 * whatever way the text was spelled.
 */
import { z } from 'zod'

import {
	DEFAULT_DELIVERY_CONFIG,
	DEFAULT_FULFILLMENT_OPTIONS,
	DEFAULT_IN_HOUSE_TIPS,
	DEFAULT_SCHEDULING,
	DEFAULT_WEEKLY_SCHEDULE,
	DeliveryConfigSchema,
	FulfillmentOptionsSchema,
	InHouseTipsSchema,
	OnlineOrderingLargeOrderSchema,
	SchedulingOptionsSchema,
	SHORT_DAY_LABELS,
	resolveTipSettings,
	TipSettingsSchema,
	WeeklyScheduleSchema,
	type DeliveryConfig,
	type FulfillmentOptions,
	type InHouseTips,
	type OnlineOrderingLargeOrder,
	type SchedulingOptions,
	type SpecialHour,
	type TipSettings,
	type WeeklySchedule,
} from './location-types.ts'
import {
	orderCapsSettingsSchema,
	type OrderCapsSettings,
} from './order-caps.ts'
import {
	packagingFeeSettingsSchema,
	type PackagingFeeSettings,
} from './packaging-fee.ts'
import {
	serviceFeeSettingsSchema,
	type ServiceFeeSettings,
} from './service-fee.ts'

/** Columns of `OrganizationLocation` the registry reads and writes. */
export type LocationSettingsRow = {
	timezone: string
	storeHours: string | null
	onlineHours: string | null
	specialHours: string | null
	prepTime: number
	largeOrderThreshold: number | null
	largeOrderThresholdType: string
	largeOrderExtraPrepTime: number
	fulfillmentOptions: string | null
	inHouseTips: string | null
	tipSettings: string | null
	serviceFee: string | null
	onlineOrderingSettings: string | null
	packagingFee: string | null
	orderCaps: string | null
	scheduling: string | null
	deliveryConfig: string | null
}

export const LOCATION_SETTINGS_COLUMNS = [
	'storeHours',
	'onlineHours',
	'specialHours',
	'prepTime',
	'largeOrderThreshold',
	'largeOrderThresholdType',
	'largeOrderExtraPrepTime',
	'fulfillmentOptions',
	'inHouseTips',
	'tipSettings',
	'serviceFee',
	'onlineOrderingSettings',
	'packagingFee',
	'orderCaps',
	'scheduling',
	'deliveryConfig',
] as const satisfies readonly (keyof LocationSettingsRow)[]

/** A partial row: only the columns a write changes. */
export type LocationSettingsPatch = Partial<
	Omit<LocationSettingsRow, 'timezone'>
>

/** Per-location facts a value depends on. */
export type LocationSettingContext = {
	/** Currency of the location (fees and tip amounts are minor units of it). */
	currency: string
}

/** Longest reason head office can give for a lock; shown to people at the location. */
export const MAX_LOCK_REASON_LENGTH = 200

export const LOCATION_SETTING_IDS = [
	'storeHours',
	'onlineHours',
	'specialHours',
	'prepTime',
	'largeOrder',
	'fulfillment',
	'tips',
	'scheduling',
	'delivery',
	'orderCaps',
	'serviceFee',
	'packagingFee',
] as const
export type LocationSettingId = (typeof LOCATION_SETTING_IDS)[number]

export function isLocationSettingId(
	value: unknown,
): value is LocationSettingId {
	return (
		typeof value === 'string' &&
		(LOCATION_SETTING_IDS as readonly string[]).includes(value)
	)
}

export type LocationSettingGroup = 'hours' | 'ordering' | 'checkout'

/** How the compare-and-edit table lets a person type a new value. */
export type LocationSettingEditor =
	| { kind: 'number'; min: number; max: number; unit: 'minutes' }
	| { kind: 'toggles'; keys: readonly string[] }

export type ParseResult<V> =
	{ ok: true; value: V } | { ok: false; error: string }

export type LocationSettingDefinition<V = unknown> = {
	id: LocationSettingId
	/** English label (the App translates by id). */
	label: string
	group: LocationSettingGroup
	columns: readonly (keyof LocationSettingsRow)[]
	/** Organization flag that must be on (a literal `true`) for this setting. */
	flag: string | null
	/** Amounts in the value are in the location's currency. */
	currencySensitive: boolean
	/** A chain default and a lock make sense for this setting. */
	chainDefault: boolean
	editor: LocationSettingEditor | null
	/** Value a location returns to when its override is cleared and no chain default exists. */
	systemDefault: (ctx: LocationSettingContext) => V
	/** Validates a canonical value from outside (a form, a chain default). */
	parse: (value: unknown) => ParseResult<V>
	/** The location's current canonical value. */
	read: (row: LocationSettingsRow, ctx: LocationSettingContext) => V
	/**
	 * The value the edit form shows (and posts back untouched) for the row:
	 * `read`, with the defaults the form fills in where a column was never saved.
	 * The lock check on a form save compares these, so saving an untouched form
	 * never counts as changing a locked setting.
	 */
	readForForm?: (row: LocationSettingsRow, ctx: LocationSettingContext) => V
	/** The columns to set so `read` returns `value`. */
	write: (
		row: LocationSettingsRow,
		value: V,
		ctx: LocationSettingContext,
	) => LocationSettingsPatch
	/** One plain-words line for previews and the compare table. */
	summarize: (value: V, ctx: LocationSettingContext) => string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseStored(text: string | null | undefined): unknown {
	if (text == null || text === '') return null
	try {
		return JSON.parse(text) as unknown
	} catch {
		return null
	}
}

function stringify(value: unknown): string | null {
	return value == null ? null : JSON.stringify(value)
}

function zodParse<V>(schema: z.ZodType<V>, value: unknown): ParseResult<V> {
	const parsed = schema.safeParse(value)
	return parsed.success
		? { ok: true, value: parsed.data }
		: { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid value' }
}

function parseOrNull<V>(schema: z.ZodType<V>, text: string | null): V | null {
	const parsed = schema.safeParse(parseStored(text))
	return parsed.success ? parsed.data : null
}

/** A stable string for a canonical value: object keys sorted, so equal values match. */
export function canonicalSettingString(value: unknown): string {
	return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, v]) => [key, sortKeys(v)]),
		)
	}
	return value
}

export function settingValuesEqual(a: unknown, b: unknown): boolean {
	return canonicalSettingString(a) === canonicalSettingString(b)
}

const DAY_ORDER = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
] as const

/** "Mon-Fri 09:00-17:00; Sat 10:00-14:00; Sun closed", or "Not set". */
export function summarizeWeeklySchedule(
	schedule: WeeklySchedule | null | undefined,
): string {
	if (!schedule || schedule.length === 0) return 'Not set'
	const byDay = new Map(schedule.map((entry) => [entry.day, entry]))
	const lines = DAY_ORDER.map((day) => {
		const entry = byDay.get(day)
		const text =
			!entry || !entry.isOpen || entry.slots.length === 0
				? 'closed'
				: entry.slots.map((slot) => `${slot.start}-${slot.end}`).join(', ')
		return { day, text }
	})
	const groups: Array<{ from: string; to: string; text: string }> = []
	for (const line of lines) {
		const last = groups[groups.length - 1]
		if (last && last.text === line.text) last.to = line.day
		else groups.push({ from: line.day, to: line.day, text: line.text })
	}
	if (groups.length === 1 && groups[0]!.text === 'closed')
		return 'Closed all week'
	return groups
		.map((group) => {
			const from = SHORT_DAY_LABELS[group.from as keyof typeof SHORT_DAY_LABELS]
			const to = SHORT_DAY_LABELS[group.to as keyof typeof SHORT_DAY_LABELS]
			const days = group.from === group.to ? from : `${from}-${to}`
			return `${days} ${group.text}`
		})
		.join('; ')
}

export function summarizeSpecialHours(entries: readonly SpecialHour[]): string {
	if (entries.length === 0) return 'None'
	const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date))
	const shown = sorted.slice(0, 3).map((entry) => {
		const text =
			!entry.isOpen || entry.slots.length === 0
				? 'closed'
				: entry.slots.map((slot) => `${slot.start}-${slot.end}`).join(', ')
		return `${entry.date} ${text}`
	})
	const more = sorted.length - shown.length
	return more > 0 ? `${shown.join('; ')}; +${more} more` : shown.join('; ')
}

// ---------------------------------------------------------------------------
// Special hours (copy and holiday helpers live here so the registry owns them)
// ---------------------------------------------------------------------------

const slotSchema = z.object({ start: z.string(), end: z.string() })
const specialHourValueSchema = z.object({
	id: z.string().min(1).max(64).optional(),
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	isOpen: z.boolean(),
	slots: z.array(slotSchema).max(8),
	note: z.string().max(200).optional(),
})

/** Special hours without ids, sorted by date: what "the same" means. */
export type SpecialHoursValue = Array<Omit<SpecialHour, 'id'> & { id?: string }>

function normalizeSpecialHours(
	list: readonly SpecialHour[],
): SpecialHoursValue {
	return [...list]
		.map(({ date, isOpen, slots, note }) => ({
			date,
			isOpen,
			slots: slots.map((slot) => ({ start: slot.start, end: slot.end })),
			...(note ? { note } : {}),
		}))
		.sort((a, b) => a.date.localeCompare(b.date))
}

function readSpecialHours(text: string | null): SpecialHour[] {
	const parsed = z.array(specialHourValueSchema).safeParse(parseStored(text))
	if (!parsed.success) return []
	return parsed.data.map((entry, index) => ({
		...entry,
		id: entry.id ?? `special_${index}`,
	}))
}

export type SpecialHoursCopyOptions = {
	/** `add` skips dates the target already has; `replace` swaps the chosen range. */
	mode: 'add' | 'replace'
	/** First date (inclusive) of the range, `YYYY-MM-DD`; empty is no lower bound. */
	from?: string | null
	/** Last date (inclusive); empty is no upper bound. */
	to?: string | null
}

function inRange(date: string, from?: string | null, to?: string | null) {
	if (from && date < from) return false
	if (to && date > to) return false
	return true
}

/**
 * New special hours for a target: `add` keeps every target entry and adds the
 * source's entries on dates the target does not have; `replace` removes the
 * target's entries inside the date range and puts the source's entries from the
 * same range in their place. New entries get ids from `makeId`.
 */
export function mergeSpecialHours(
	sourceText: string | null,
	targetText: string | null,
	options: SpecialHoursCopyOptions,
	makeId: () => string,
): SpecialHour[] {
	const source = readSpecialHours(sourceText).filter((entry) =>
		inRange(entry.date, options.from, options.to),
	)
	const target = readSpecialHours(targetText)
	const fresh = (entry: SpecialHour): SpecialHour => ({
		...entry,
		id: makeId(),
	})
	if (options.mode === 'replace') {
		const kept = target.filter(
			(entry) => !inRange(entry.date, options.from, options.to),
		)
		return [...kept, ...source.map(fresh)].sort((a, b) =>
			a.date.localeCompare(b.date),
		)
	}
	const taken = new Set(target.map((entry) => entry.date))
	const added = source.filter((entry) => !taken.has(entry.date)).map(fresh)
	return [...target, ...added].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Adds one holiday to a location's special hours. A date the location already
 * has is left alone (`added: false`).
 */
export function addHolidayToSpecialHours(
	targetText: string | null,
	holiday: Omit<SpecialHour, 'id'>,
	makeId: () => string,
): { added: boolean; entries: SpecialHour[] } {
	const target = readSpecialHours(targetText)
	if (target.some((entry) => entry.date === holiday.date)) {
		return { added: false, entries: target }
	}
	return {
		added: true,
		entries: [...target, { ...holiday, id: makeId() }].sort((a, b) =>
			a.date.localeCompare(b.date),
		),
	}
}

// ---------------------------------------------------------------------------
// The definitions
// ---------------------------------------------------------------------------

const weeklyDefinition = (
	id: 'storeHours' | 'onlineHours',
	label: string,
): LocationSettingDefinition<WeeklySchedule | null> => ({
	id,
	label,
	group: 'hours',
	columns: [id],
	flag: null,
	currencySensitive: false,
	chainDefault: true,
	editor: null,
	systemDefault: () => null,
	parse: (value) =>
		value === null
			? { ok: true, value: null }
			: zodParse(WeeklyScheduleSchema, value),
	read: (row) => parseOrNull(WeeklyScheduleSchema, row[id]),
	readForForm: (row) =>
		parseOrNull(WeeklyScheduleSchema, row[id]) ?? DEFAULT_WEEKLY_SCHEDULE,
	write: (_row, value) => ({ [id]: stringify(value) }),
	summarize: (value) => summarizeWeeklySchedule(value),
})

type LargeOrderValue = {
	threshold: number | null
	thresholdType: string
	extraPrepTime: number
	rule: OnlineOrderingLargeOrder | null
}

const largeOrderValueSchema: z.ZodType<LargeOrderValue> = z.object({
	threshold: z.number().min(0).nullable(),
	thresholdType: z.string().min(1).max(20),
	extraPrepTime: z.number().int().min(0).max(240),
	rule: OnlineOrderingLargeOrderSchema.nullable(),
})

type TipsValue = {
	inHouseTips: InHouseTips | null
	tipSettings: TipSettings
}

const tipsValueSchema: z.ZodType<TipsValue> = z.object({
	inHouseTips: InHouseTipsSchema.nullable(),
	tipSettings: TipSettingsSchema,
})

const PREP_TIME_MAX = 1440

function describeAmount(minor: number, currency: string) {
	return `${(minor / 100).toFixed(2)} ${currency}`
}

function describeTipChoices(
	settings: TipSettings['pickup'],
	currency: string,
): string {
	const choices = settings.choices.map((choice) =>
		'percent' in choice
			? `${choice.percent}%`
			: describeAmount(choice.amountMinor, currency),
	)
	if (settings.allowCustom) choices.push('custom')
	return choices.length > 0 ? choices.join(' / ') : 'no buttons'
}

export const LOCATION_SETTINGS_REGISTRY: {
	[K in LocationSettingId]: LocationSettingDefinition<any>
} = {
	storeHours: weeklyDefinition('storeHours', 'Store hours'),
	onlineHours: weeklyDefinition('onlineHours', 'Online ordering hours'),

	specialHours: {
		id: 'specialHours',
		label: 'Special hours (holidays)',
		group: 'hours',
		columns: ['specialHours'],
		flag: null,
		currencySensitive: false,
		// Holidays belong to one place and one year; a chain default makes no sense.
		chainDefault: false,
		editor: null,
		systemDefault: () => [] as SpecialHoursValue,
		parse: (value) => zodParse(z.array(specialHourValueSchema), value),
		read: (row) => normalizeSpecialHours(readSpecialHours(row.specialHours)),
		write: (_row, value: SpecialHoursValue) => ({
			specialHours:
				value.length === 0
					? null
					: JSON.stringify(
							value.map((entry, index) => ({
								...entry,
								id: entry.id ?? `special_${index}`,
							})),
						),
		}),
		summarize: (value: SpecialHoursValue) =>
			summarizeSpecialHours(
				value.map((entry, index) => ({
					...entry,
					id: entry.id ?? String(index),
				})),
			),
	} satisfies LocationSettingDefinition<SpecialHoursValue>,

	prepTime: {
		id: 'prepTime',
		label: 'Prep time',
		group: 'ordering',
		columns: ['prepTime'],
		flag: null,
		currencySensitive: false,
		chainDefault: true,
		editor: { kind: 'number', min: 0, max: PREP_TIME_MAX, unit: 'minutes' },
		systemDefault: () => 15,
		parse: (value) =>
			zodParse(z.number().int().min(0).max(PREP_TIME_MAX), value),
		read: (row) => row.prepTime,
		write: (_row, value: number) => ({ prepTime: value }),
		summarize: (value: number) => `${value} min`,
	} satisfies LocationSettingDefinition<number>,

	largeOrder: {
		id: 'largeOrder',
		label: 'Large-order rules',
		group: 'ordering',
		columns: [
			'largeOrderThreshold',
			'largeOrderThresholdType',
			'largeOrderExtraPrepTime',
			'onlineOrderingSettings',
		],
		flag: null,
		currencySensitive: true,
		chainDefault: true,
		editor: null,
		systemDefault: (): LargeOrderValue => ({
			threshold: 100,
			thresholdType: 'dollars',
			extraPrepTime: 15,
			rule: null,
		}),
		parse: (value) => zodParse(largeOrderValueSchema, value),
		read: (row): LargeOrderValue => {
			const settings = parseStored(row.onlineOrderingSettings)
			const rule =
				settings && typeof settings === 'object'
					? OnlineOrderingLargeOrderSchema.safeParse(
							(settings as Record<string, unknown>).largeOrder,
						)
					: null
			return {
				threshold: row.largeOrderThreshold,
				thresholdType: row.largeOrderThresholdType,
				extraPrepTime: row.largeOrderExtraPrepTime,
				rule: rule?.success ? rule.data : null,
			}
		},
		write: (row, value: LargeOrderValue): LocationSettingsPatch => {
			const patch: LocationSettingsPatch = {
				largeOrderThreshold: value.threshold,
				largeOrderThresholdType: value.thresholdType,
				largeOrderExtraPrepTime: value.extraPrepTime,
			}
			const existing = parseStored(row.onlineOrderingSettings)
			const base =
				existing && typeof existing === 'object' && !Array.isArray(existing)
					? { ...(existing as Record<string, unknown>) }
					: null
			if (value.rule) {
				// Only the large-order key of the settings changes: buffers, hours
				// modes and utensils stay as the target has them.
				patch.onlineOrderingSettings = JSON.stringify({
					buffers: { openingBufferMinutes: 0, closingBufferMinutes: 0 },
					pickup: 'follow_online',
					delivery: 'follow_online',
					catering: 'follow_online',
					syncOnlineWithStore: true,
					...base,
					largeOrder: value.rule,
				})
			} else if (base && 'largeOrder' in base) {
				delete base.largeOrder
				patch.onlineOrderingSettings = JSON.stringify(base)
			}
			return patch
		},
		summarize: (value: LargeOrderValue, ctx) => {
			if (value.rule) {
				const parts: string[] = []
				if (value.rule.itemThreshold)
					parts.push(`over ${value.rule.itemThreshold} items`)
				if (value.rule.amountMinor)
					parts.push(
						`over ${describeAmount(value.rule.amountMinor, ctx.currency)}`,
					)
				return parts.length === 0
					? 'No large-order rule'
					: `${parts.join(' or ')}: +${value.rule.extraMinutes} min`
			}
			return value.threshold == null
				? 'No large-order rule'
				: `Over ${value.threshold} ${value.thresholdType}: +${value.extraPrepTime} min`
		},
	} satisfies LocationSettingDefinition<LargeOrderValue>,

	fulfillment: {
		id: 'fulfillment',
		label: 'Fulfillment options',
		group: 'ordering',
		columns: ['fulfillmentOptions'],
		flag: null,
		currencySensitive: false,
		chainDefault: true,
		editor: {
			kind: 'toggles',
			keys: ['pickup', 'delivery', 'dineIn', 'curbside'],
		},
		systemDefault: (): FulfillmentOptions => ({
			...DEFAULT_FULFILLMENT_OPTIONS,
		}),
		parse: (value) => zodParse(FulfillmentOptionsSchema, value),
		read: (row): FulfillmentOptions => {
			// A location that never saved options shows the edit form's defaults.
			const parsed = FulfillmentOptionsSchema.safeParse(
				parseStored(row.fulfillmentOptions),
			)
			return parsed.success ? parsed.data : { ...DEFAULT_FULFILLMENT_OPTIONS }
		},
		write: (_row, value: FulfillmentOptions) => ({
			fulfillmentOptions: JSON.stringify(value),
		}),
		summarize: (value: FulfillmentOptions) => {
			const on = [
				value.pickup ? 'Pickup' : null,
				value.delivery ? 'Delivery' : null,
				value.dineIn ? 'Dine-in' : null,
				value.curbside ? 'Curbside' : null,
			].filter(Boolean)
			return on.length > 0 ? on.join(', ') : 'Nothing offered'
		},
	} satisfies LocationSettingDefinition<FulfillmentOptions>,

	tips: {
		id: 'tips',
		label: 'Tips',
		group: 'checkout',
		columns: ['inHouseTips', 'tipSettings'],
		flag: null,
		currencySensitive: true,
		chainDefault: true,
		editor: null,
		systemDefault: (ctx): TipsValue => ({
			inHouseTips: null,
			tipSettings: resolveTipSettings(null, ctx.currency),
		}),
		parse: (value) => zodParse(tipsValueSchema, value),
		read: (row, ctx): TipsValue => ({
			inHouseTips: parseOrNull(InHouseTipsSchema, row.inHouseTips),
			tipSettings: resolveTipSettings(row.tipSettings, ctx.currency),
		}),
		readForForm: (row, ctx): TipsValue => ({
			inHouseTips:
				parseOrNull(InHouseTipsSchema, row.inHouseTips) ??
				DEFAULT_IN_HOUSE_TIPS,
			tipSettings: resolveTipSettings(row.tipSettings, ctx.currency),
		}),
		write: (_row, value: TipsValue) => ({
			inHouseTips: stringify(value.inHouseTips),
			tipSettings: JSON.stringify(value.tipSettings),
		}),
		summarize: (value: TipsValue, ctx) =>
			`Pickup ${describeTipChoices(value.tipSettings.pickup, ctx.currency)}; delivery ${describeTipChoices(value.tipSettings.delivery, ctx.currency)}`,
	} satisfies LocationSettingDefinition<TipsValue>,

	scheduling: {
		id: 'scheduling',
		label: 'Scheduled (advance) orders',
		group: 'ordering',
		columns: ['scheduling'],
		flag: null,
		currencySensitive: false,
		chainDefault: true,
		editor: null,
		systemDefault: (): SchedulingOptions => ({
			scheduledOrdersEnabled: true,
			advanceOrderDays: 7,
		}),
		parse: (value) =>
			value === null
				? { ok: true, value: null }
				: zodParse(SchedulingOptionsSchema, value),
		read: (row) => parseOrNull(SchedulingOptionsSchema, row.scheduling),
		readForForm: (row) =>
			parseOrNull(SchedulingOptionsSchema, row.scheduling) ??
			DEFAULT_SCHEDULING,
		write: (_row, value: SchedulingOptions | null) => ({
			scheduling: stringify(value),
		}),
		summarize: (value: SchedulingOptions | null) =>
			!value
				? 'Default'
				: value.scheduledOrdersEnabled
					? `On, up to ${value.advanceOrderDays} days ahead`
					: 'Off',
	} satisfies LocationSettingDefinition<SchedulingOptions | null>,

	delivery: {
		id: 'delivery',
		label: 'Delivery settings (providers and times)',
		group: 'ordering',
		columns: ['deliveryConfig'],
		flag: null,
		currencySensitive: false,
		chainDefault: true,
		editor: null,
		systemDefault: (): DeliveryConfig => ({ ...DEFAULT_DELIVERY_CONFIG }),
		parse: (value) => zodParse(DeliveryConfigSchema, value),
		read: (row): DeliveryConfig => {
			// The edit form accepts an older spelling of the time keys; so do we.
			const raw = parseStored(row.deliveryConfig)
			if (!raw || typeof raw !== 'object') return { ...DEFAULT_DELIVERY_CONFIG }
			const parsed = raw as Record<string, unknown>
			const providers =
				Array.isArray(parsed.providers) && parsed.providers.length > 0
					? (parsed.providers as DeliveryConfig['providers'])
					: DEFAULT_DELIVERY_CONFIG.providers
			const min = Number(
				parsed.estimatedDeliveryTimeMin ??
					parsed.estimatedTimeMin ??
					DEFAULT_DELIVERY_CONFIG.estimatedDeliveryTimeMin,
			)
			const max = Number(
				parsed.estimatedDeliveryTimeMax ??
					parsed.estimatedTimeMax ??
					DEFAULT_DELIVERY_CONFIG.estimatedDeliveryTimeMax,
			)
			return {
				providers,
				estimatedDeliveryTimeMin: Number.isFinite(min)
					? min
					: DEFAULT_DELIVERY_CONFIG.estimatedDeliveryTimeMin,
				estimatedDeliveryTimeMax: Number.isFinite(max)
					? max
					: DEFAULT_DELIVERY_CONFIG.estimatedDeliveryTimeMax,
			}
		},
		write: (_row, value: DeliveryConfig) => ({
			deliveryConfig: JSON.stringify(value),
		}),
		summarize: (value: DeliveryConfig) =>
			`${value.providers.join(', ')}; ${value.estimatedDeliveryTimeMin}-${value.estimatedDeliveryTimeMax} min`,
	} satisfies LocationSettingDefinition<DeliveryConfig>,

	orderCaps: {
		id: 'orderCaps',
		label: 'Order size caps',
		group: 'ordering',
		columns: ['orderCaps'],
		flag: null,
		currencySensitive: true,
		chainDefault: true,
		editor: null,
		systemDefault: () => null,
		parse: (value) =>
			value === null
				? { ok: true, value: null }
				: zodParse(orderCapsSettingsSchema, value),
		read: (row) => parseOrNull(orderCapsSettingsSchema, row.orderCaps),
		write: (_row, value: OrderCapsSettings | null) => ({
			orderCaps: stringify(value),
		}),
		summarize: (value: OrderCapsSettings | null, ctx) => {
			if (!value) return 'No caps'
			const parts: string[] = []
			if (value.pickup?.maxSubtotalMinor)
				parts.push(
					`pickup up to ${describeAmount(value.pickup.maxSubtotalMinor, ctx.currency)}`,
				)
			if (value.delivery?.maxSubtotalMinor)
				parts.push(
					`delivery up to ${describeAmount(value.delivery.maxSubtotalMinor, ctx.currency)}`,
				)
			if (value.dineIn?.maxGuests)
				parts.push(`dine-in up to ${value.dineIn.maxGuests} guests`)
			return parts.length > 0 ? parts.join('; ') : 'No caps'
		},
	} satisfies LocationSettingDefinition<OrderCapsSettings | null>,

	serviceFee: {
		id: 'serviceFee',
		label: 'Service fee',
		group: 'checkout',
		columns: ['serviceFee'],
		flag: 'ordering.service_fee',
		currencySensitive: true,
		chainDefault: true,
		editor: null,
		systemDefault: () => null,
		parse: (value) =>
			value === null
				? { ok: true, value: null }
				: zodParse(serviceFeeSettingsSchema, value),
		read: (row) => parseOrNull(serviceFeeSettingsSchema, row.serviceFee),
		write: (_row, value: ServiceFeeSettings | null) => ({
			serviceFee: stringify(value),
		}),
		summarize: (value: ServiceFeeSettings | null) =>
			!value ? 'No fee' : JSON.stringify(sortKeys(value)).slice(0, 120),
	} satisfies LocationSettingDefinition<ServiceFeeSettings | null>,

	packagingFee: {
		id: 'packagingFee',
		label: 'Packaging fee',
		group: 'checkout',
		columns: ['packagingFee'],
		flag: 'ordering.packaging_fee',
		currencySensitive: true,
		chainDefault: true,
		editor: null,
		systemDefault: () => null,
		parse: (value) =>
			value === null
				? { ok: true, value: null }
				: zodParse(packagingFeeSettingsSchema, value),
		read: (row) => parseOrNull(packagingFeeSettingsSchema, row.packagingFee),
		write: (_row, value: PackagingFeeSettings | null) => ({
			packagingFee: stringify(value),
		}),
		summarize: (value: PackagingFeeSettings | null, ctx) =>
			!value || !value.enabled
				? 'Off'
				: `${describeAmount(value.amountMinor, ctx.currency)} ${value.mode === 'per_item' ? 'per item' : 'per order'}`,
	} satisfies LocationSettingDefinition<PackagingFeeSettings | null>,
}

export function getLocationSetting(
	id: LocationSettingId,
): LocationSettingDefinition<any> {
	return LOCATION_SETTINGS_REGISTRY[id]
}

/** Registry entries in display order. */
export function listLocationSettings(): LocationSettingDefinition<any>[] {
	return LOCATION_SETTING_IDS.map((id) => LOCATION_SETTINGS_REGISTRY[id])
}

/** A location's current canonical value of one setting. */
export function readLocationSetting(
	id: LocationSettingId,
	row: LocationSettingsRow,
	ctx: LocationSettingContext,
): unknown {
	return getLocationSetting(id).read(row, ctx)
}

/** One line in plain words for a location's current value of a setting. */
export function summarizeLocationSetting(
	id: LocationSettingId,
	row: LocationSettingsRow,
	ctx: LocationSettingContext,
): string {
	const definition = getLocationSetting(id)
	return definition.summarize(definition.read(row, ctx), ctx)
}

/** Whether two locations hold the same value of a setting. */
export function locationSettingsMatch(
	id: LocationSettingId,
	a: LocationSettingsRow,
	aCtx: LocationSettingContext,
	b: LocationSettingsRow,
	bCtx: LocationSettingContext,
): boolean {
	const definition = getLocationSetting(id)
	return settingValuesEqual(definition.read(a, aCtx), definition.read(b, bCtx))
}

/**
 * Applies a value to a row's columns, returning the new row. Only the columns
 * the setting owns change.
 */
export function applySettingValue(
	id: LocationSettingId,
	row: LocationSettingsRow,
	value: unknown,
	ctx: LocationSettingContext,
): { row: LocationSettingsRow; patch: LocationSettingsPatch } {
	const patch = getLocationSetting(id).write(row, value, ctx)
	return { row: { ...row, ...patch }, patch }
}

/**
 * Every setting whose value differs between two versions of a row as the edit
 * form sees them (`readForForm`): a form save that posts back what it loaded is
 * never a change.
 */
export function changedLocationSettingsInForm(
	before: LocationSettingsRow,
	after: LocationSettingsRow,
	ctx: LocationSettingContext,
): LocationSettingId[] {
	return LOCATION_SETTING_IDS.filter((id) => {
		const definition = getLocationSetting(id)
		const read = definition.readForForm ?? definition.read
		return !settingValuesEqual(read(before, ctx), read(after, ctx))
	})
}

/**
 * Every setting whose canonical value differs between two versions of a row.
 * The lock check on a location save compares the stored row with the row the
 * save would produce.
 */
export function changedLocationSettings(
	before: LocationSettingsRow,
	after: LocationSettingsRow,
	ctx: LocationSettingContext,
): LocationSettingId[] {
	return LOCATION_SETTING_IDS.filter(
		(id) =>
			!settingValuesEqual(
				getLocationSetting(id).read(before, ctx),
				getLocationSetting(id).read(after, ctx),
			),
	)
}
