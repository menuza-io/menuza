/**
 * Location settings for online ordering hours modes, buffers (#330), slot
 * limits (#108), variable prep windows, and prayer pauses. Form state is JSON
 * in the posted payload; this file parses it into `OrganizationLocation` text
 * columns. Slot limits and prayer pause groups are skipped when their org flag
 * is off so a stale form cannot change them.
 */
import {
	parseLocationPrepSchedule,
	parseOnlineOrderingSettings,
	parsePrayerPauseSettings,
	parseSlotLimitSettings,
} from '@repo/common/location-settings'
import {
	FulfillmentHoursModeSchema,
	type FulfillmentHoursMode,
	type OnlineOrderingLargeOrder,
	OnlineOrderingSettingsSchema,
	type PrayerPauseSettings,
	PrayerPauseSettingsSchema,
	PrepScheduleSchema,
	SlotLimitSettingsSchema,
} from '@repo/common/location-types'
import { z } from 'zod'
import { parseMoneyToMinor, parseWholeNumber } from '#app/utils/money-input.ts'

export type OrderingSettingsPatch = {
	onlineOrderingSettings?: string | null
	slotLimitSettings?: string | null
	prepSchedule?: string | null
	prayerPauseSettings?: string | null
}

export type OnlineOrderingFormValues = {
	openingBufferMinutes: string
	closingBufferMinutes: string
	pickup: FulfillmentHoursMode
	delivery: FulfillmentHoursMode
	catering: FulfillmentHoursMode
	syncOnlineWithStore: boolean
	utensilsEnabled: boolean
	utensilsDefaultRequested: boolean
	/** Large orders (#355): more than this many items, as typed; empty is none. */
	largeOrderItems: string
	/** Over this amount in the location's currency, as typed; empty is none. */
	largeOrderAmount: string
	/** Minutes added to the ready time; empty is none. */
	largeOrderMinutes: string
}

/**
 * The single threshold the location columns held before large orders took two
 * (#355). Read as the starting point of a location that was never saved with
 * the new settings; those columns are not written any more.
 */
export type LegacyLargeOrder = {
	largeOrderThreshold: number | null | undefined
	largeOrderThresholdType: string | null | undefined
	largeOrderExtraPrepTime: number | null | undefined
}

export type LargeOrderFormFields = Pick<
	OnlineOrderingFormValues,
	'largeOrderItems' | 'largeOrderAmount' | 'largeOrderMinutes'
>

/** Minor units as a typed amount: 30000 is "300", 30050 is "300.5". */
export function minorToAmountInput(minor: number): string {
	const major = minor / 100
	return Number.isInteger(major)
		? String(major)
		: String(Number(major.toFixed(2)))
}

/** The old single threshold as the new fields (an unusable one is no rule). */
export function largeOrderFieldsFromLegacy(
	legacy: LegacyLargeOrder | undefined,
): LargeOrderFormFields {
	const none = {
		largeOrderItems: '',
		largeOrderAmount: '',
		largeOrderMinutes: '',
	}
	if (!legacy) return none
	const threshold = legacy.largeOrderThreshold
	const minutes = legacy.largeOrderExtraPrepTime
	if (
		typeof threshold !== 'number' ||
		!Number.isFinite(threshold) ||
		threshold <= 0 ||
		typeof minutes !== 'number' ||
		!Number.isFinite(minutes) ||
		minutes <= 0
	) {
		return none
	}
	if (legacy.largeOrderThresholdType === 'items') {
		return {
			largeOrderItems: String(Math.max(1, Math.round(threshold))),
			largeOrderAmount: '',
			largeOrderMinutes: String(Math.round(minutes)),
		}
	}
	if (legacy.largeOrderThresholdType === 'dollars') {
		return {
			largeOrderItems: '',
			largeOrderAmount: minorToAmountInput(Math.round(threshold * 100)),
			largeOrderMinutes: String(Math.round(minutes)),
		}
	}
	return none
}

export function largeOrderFieldsFromSaved(
	saved: OnlineOrderingLargeOrder,
): LargeOrderFormFields {
	return {
		largeOrderItems:
			saved.itemThreshold === null ? '' : String(saved.itemThreshold),
		largeOrderAmount:
			saved.amountMinor === null ? '' : minorToAmountInput(saved.amountMinor),
		largeOrderMinutes: saved.extraMinutes > 0 ? String(saved.extraMinutes) : '',
	}
}

export type SlotLimitFormValues = {
	enabled: boolean
	unit: 'orders' | 'dishes'
	defaultLimit: string
	pickupLimit: string
	deliveryLimit: string
	allowOneLargeOrderPerSlot: boolean
}

export type PrepScheduleFormRow = {
	days: string[]
	from: string
	to: string
	minutes: string
}

export type PrayerPauseFormValues = {
	enabled: boolean
	calculationMethod: 'UmmAlQura' | 'MuslimWorldLeague' | 'Egyptian'
	prayers: Array<{
		name: 'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha'
		beforeMinutes: string
		afterMinutes: string
	}>
}

export type OrderingSettingsFormBundle = {
	online: OnlineOrderingFormValues
	slot: SlotLimitFormValues
	prep: PrepScheduleFormRow[]
	prayer: PrayerPauseFormValues
}

const PRAYER_NAMES = [
	'fajr',
	'dhuhr',
	'asr',
	'maghrib',
	'isha',
] as const satisfies PrayerPauseSettings['prayers'][number]['name'][]

export function defaultOnlineOrderingForm(): OnlineOrderingFormValues {
	return {
		openingBufferMinutes: '0',
		closingBufferMinutes: '0',
		pickup: 'follow_online',
		delivery: 'follow_online',
		catering: 'follow_online',
		syncOnlineWithStore: true,
		utensilsEnabled: false,
		utensilsDefaultRequested: false,
		// A new location starts with the rule locations have always started
		// with: over 100.00, add 15 minutes.
		largeOrderItems: '',
		largeOrderAmount: '100',
		largeOrderMinutes: '15',
	}
}

export function defaultSlotLimitForm(): SlotLimitFormValues {
	return {
		enabled: false,
		unit: 'orders',
		defaultLimit: '',
		pickupLimit: '',
		deliveryLimit: '',
		allowOneLargeOrderPerSlot: false,
	}
}

export function defaultPrayerPauseForm(): PrayerPauseFormValues {
	return {
		enabled: false,
		calculationMethod: 'UmmAlQura',
		prayers: PRAYER_NAMES.map((name) => ({
			name,
			beforeMinutes: '5',
			afterMinutes: '15',
		})),
	}
}

export function onlineOrderingFormFromRecord(
	raw: unknown,
	legacy?: LegacyLargeOrder,
): OnlineOrderingFormValues {
	const parsed = parseOnlineOrderingSettings(raw)
	// The saved large-order rule wins, even one with no threshold (switched
	// off); a location that never saved one starts from its old columns.
	const largeOrder = parsed?.largeOrder
		? largeOrderFieldsFromSaved(parsed.largeOrder)
		: legacy
			? largeOrderFieldsFromLegacy(legacy)
			: {
					largeOrderItems: defaultOnlineOrderingForm().largeOrderItems,
					largeOrderAmount: defaultOnlineOrderingForm().largeOrderAmount,
					largeOrderMinutes: defaultOnlineOrderingForm().largeOrderMinutes,
				}
	if (!parsed) return { ...defaultOnlineOrderingForm(), ...largeOrder }
	return {
		openingBufferMinutes: String(parsed.buffers.openingBufferMinutes),
		closingBufferMinutes: String(parsed.buffers.closingBufferMinutes),
		pickup: parsed.pickup,
		delivery: parsed.delivery,
		catering: parsed.catering,
		syncOnlineWithStore: parsed.syncOnlineWithStore,
		utensilsEnabled: parsed.utensils?.enabled === true,
		utensilsDefaultRequested: parsed.utensils?.defaultRequested === true,
		...largeOrder,
	}
}

export function slotLimitFormFromRecord(raw: unknown): SlotLimitFormValues {
	const parsed = parseSlotLimitSettings(raw)
	if (!parsed) return defaultSlotLimitForm()
	const limitStr = (n: number | null | undefined) =>
		n == null ? '' : String(n)
	return {
		enabled: parsed.enabled,
		unit: parsed.unit,
		defaultLimit: limitStr(parsed.defaultLimit),
		pickupLimit: limitStr(parsed.pickupLimit ?? null),
		deliveryLimit: limitStr(parsed.deliveryLimit ?? null),
		allowOneLargeOrderPerSlot: parsed.allowOneLargeOrderPerSlot,
	}
}

export function prepScheduleFormFromRecord(
	raw: unknown,
): PrepScheduleFormRow[] {
	const parsed = parseLocationPrepSchedule(raw)
	if (!parsed?.length) return []
	return parsed.map((row) => ({
		days: [...row.days],
		from: row.from,
		to: row.to,
		minutes: String(row.minutes),
	}))
}

export function prayerPauseFormFromRecord(raw: unknown): PrayerPauseFormValues {
	const parsed = parsePrayerPauseSettings(raw)
	const base = defaultPrayerPauseForm()
	if (!parsed) return base
	const byName = new Map(parsed.prayers.map((p) => [p.name, p]))
	return {
		enabled: parsed.enabled,
		calculationMethod: parsed.calculationMethod,
		prayers: PRAYER_NAMES.map((name) => {
			const row = byName.get(name)
			return {
				name,
				beforeMinutes: String(row?.beforeMinutes ?? 5),
				afterMinutes: String(row?.afterMinutes ?? 15),
			}
		}),
	}
}

export function orderingSettingsFormFromRecord(record: {
	onlineOrderingSettings: unknown
	slotLimitSettings: unknown
	prepSchedule: unknown
	prayerPauseSettings: unknown
	/** The location's old single large-order threshold columns. */
	legacyLargeOrder?: LegacyLargeOrder
}): OrderingSettingsFormBundle {
	return {
		online: onlineOrderingFormFromRecord(
			record.onlineOrderingSettings,
			record.legacyLargeOrder,
		),
		slot: slotLimitFormFromRecord(record.slotLimitSettings),
		prep: prepScheduleFormFromRecord(record.prepSchedule),
		prayer: prayerPauseFormFromRecord(record.prayerPauseSettings),
	}
}

function blankLimit(raw: string): number | null {
	const trimmed = raw.trim()
	if (!trimmed) return null
	const n = Number.parseInt(trimmed, 10)
	return Number.isFinite(n) ? n : Number.NaN
}

/**
 * The large-order fields as the saved rule. Nothing posted (a form from before
 * large orders took two thresholds) is nothing saved, so the location keeps
 * reading its old columns. A threshold needs the minutes to add.
 */
export function largeOrderFromForm(
	values: Partial<LargeOrderFormFields>,
):
	| { ok: true; value: OnlineOrderingLargeOrder | undefined }
	| { ok: false; error: string } {
	if (
		values.largeOrderItems === undefined &&
		values.largeOrderAmount === undefined &&
		values.largeOrderMinutes === undefined
	) {
		return { ok: true, value: undefined }
	}
	const itemsText = (values.largeOrderItems ?? '').trim()
	const amountText = (values.largeOrderAmount ?? '').trim()
	const minutesText = (values.largeOrderMinutes ?? '').trim()

	let itemThreshold: number | null = null
	if (itemsText !== '') {
		itemThreshold = parseWholeNumber(itemsText, { min: 1, max: 1000 })
		if (itemThreshold === null) {
			return { ok: false, error: LARGE_ORDER_ITEMS_ERROR }
		}
	}
	let amountMinor: number | null = null
	if (amountText !== '') {
		// Two decimals, as the ordering engine counts every currency (x100).
		amountMinor = parseMoneyToMinor(amountText, {
			min: 1,
			max: 1_000_000_000,
		})
		if (amountMinor === null) {
			return { ok: false, error: LARGE_ORDER_AMOUNT_ERROR }
		}
	}
	let extraMinutes = 0
	if (minutesText !== '') {
		const minutes = parseWholeNumber(minutesText, { min: 0, max: 240 })
		if (minutes === null) {
			return { ok: false, error: LARGE_ORDER_MINUTES_ERROR }
		}
		extraMinutes = minutes
	}
	if ((itemThreshold !== null || amountMinor !== null) && extraMinutes === 0) {
		return { ok: false, error: LARGE_ORDER_NEEDS_MINUTES_ERROR }
	}
	return { ok: true, value: { itemThreshold, amountMinor, extraMinutes } }
}

export const LARGE_ORDER_ITEMS_ERROR =
	'Enter a whole number of items from 1 to 1,000, or leave it empty.'
export const LARGE_ORDER_AMOUNT_ERROR =
	'Enter an amount like 300 or 300.50, or leave it empty.'
export const LARGE_ORDER_MINUTES_ERROR = 'Enter minutes from 0 to 240.'
export const LARGE_ORDER_NEEDS_MINUTES_ERROR =
	'Enter how many minutes to add for a large order.'

function onlineFromForm(
	values: Omit<OnlineOrderingFormValues, keyof LargeOrderFormFields> &
		Partial<LargeOrderFormFields>,
	largeOrder: OnlineOrderingLargeOrder | undefined,
) {
	const opening = Number.parseInt(values.openingBufferMinutes, 10)
	const closing = Number.parseInt(values.closingBufferMinutes, 10)
	return OnlineOrderingSettingsSchema.safeParse({
		buffers: {
			openingBufferMinutes: Number.isFinite(opening) ? opening : 0,
			closingBufferMinutes: Number.isFinite(closing) ? closing : 0,
		},
		pickup: values.pickup,
		delivery: values.delivery,
		catering: values.catering,
		syncOnlineWithStore: values.syncOnlineWithStore,
		utensils: {
			enabled: values.utensilsEnabled,
			defaultRequested: values.utensilsDefaultRequested,
		},
		...(largeOrder ? { largeOrder } : {}),
	})
}

function slotFromForm(values: SlotLimitFormValues) {
	const defaultLimit = blankLimit(values.defaultLimit)
	const pickupLimit = blankLimit(values.pickupLimit)
	const deliveryLimit = blankLimit(values.deliveryLimit)
	if (
		(defaultLimit != null && Number.isNaN(defaultLimit)) ||
		(pickupLimit != null && Number.isNaN(pickupLimit)) ||
		(deliveryLimit != null && Number.isNaN(deliveryLimit))
	) {
		return { ok: false as const, error: 'Slot limits must be whole numbers.' }
	}
	const parsed = SlotLimitSettingsSchema.safeParse({
		enabled: values.enabled,
		unit: values.unit,
		defaultLimit,
		pickupLimit: pickupLimit ?? undefined,
		deliveryLimit: deliveryLimit ?? undefined,
		allowOneLargeOrderPerSlot: values.allowOneLargeOrderPerSlot,
	})
	if (!parsed.success) {
		const msg =
			parsed.error.issues[0]?.message ?? 'Check the slot limit settings.'
		return { ok: false as const, error: msg }
	}
	return { ok: true as const, settings: parsed.data }
}

function prepFromForm(rows: PrepScheduleFormRow[]) {
	const mapped = rows.map((row) => ({
		days: row.days,
		from: row.from,
		to: row.to,
		minutes: Number.parseInt(row.minutes, 10),
	}))
	const parsed = PrepScheduleSchema.safeParse(mapped)
	if (!parsed.success) {
		const msg =
			parsed.error.issues[0]?.message ?? 'Check the variable prep schedule.'
		return { ok: false as const, error: msg }
	}
	return { ok: true as const, schedule: parsed.data }
}

function prayerFromForm(values: PrayerPauseFormValues) {
	const parsed = PrayerPauseSettingsSchema.safeParse({
		enabled: values.enabled,
		calculationMethod: values.calculationMethod,
		prayers: values.enabled
			? values.prayers.map((row) => ({
					name: row.name,
					beforeMinutes: Number.parseInt(row.beforeMinutes, 10),
					afterMinutes: Number.parseInt(row.afterMinutes, 10),
				}))
			: [],
	})
	if (!parsed.success) {
		const msg =
			parsed.error.issues[0]?.message ?? 'Check the prayer pause settings.'
		return { ok: false as const, error: msg }
	}
	return { ok: true as const, settings: parsed.data }
}

const bundleSchema = z.object({
	online: z.object({
		openingBufferMinutes: z.string(),
		closingBufferMinutes: z.string(),
		pickup: FulfillmentHoursModeSchema,
		delivery: FulfillmentHoursModeSchema,
		catering: FulfillmentHoursModeSchema,
		syncOnlineWithStore: z.boolean(),
		utensilsEnabled: z.boolean(),
		utensilsDefaultRequested: z.boolean(),
		largeOrderItems: z.string().optional(),
		largeOrderAmount: z.string().optional(),
		largeOrderMinutes: z.string().optional(),
	}),
	slot: z.object({
		enabled: z.boolean(),
		unit: z.enum(['orders', 'dishes']),
		defaultLimit: z.string(),
		pickupLimit: z.string(),
		deliveryLimit: z.string(),
		allowOneLargeOrderPerSlot: z.boolean(),
	}),
	prep: z.array(
		z.object({
			days: z.array(z.string()),
			from: z.string(),
			to: z.string(),
			minutes: z.string(),
		}),
	),
	prayer: z.object({
		enabled: z.boolean(),
		calculationMethod: z.enum(['UmmAlQura', 'MuslimWorldLeague', 'Egyptian']),
		prayers: z.array(
			z.object({
				name: z.enum(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']),
				beforeMinutes: z.string(),
				afterMinutes: z.string(),
			}),
		),
	}),
})

export function parseOrderingSettingsFields(
	raw: Record<string, unknown>,
	flags: { slotLimits: boolean; prayerPause: boolean },
): { ok: true; patch: OrderingSettingsPatch } | { ok: false; error: string } {
	const json = raw.orderingSettings
	if (typeof json !== 'string' || !json.trim()) {
		return { ok: true, patch: {} }
	}
	let parsedJson: unknown
	try {
		parsedJson = JSON.parse(json)
	} catch {
		return { ok: false, error: 'Could not read ordering settings.' }
	}
	const bundle = bundleSchema.safeParse(parsedJson)
	if (!bundle.success) {
		return { ok: false, error: 'Could not read ordering settings.' }
	}
	const { online, slot, prep, prayer } = bundle.data
	const patch: OrderingSettingsPatch = {}

	const largeOrderResult = largeOrderFromForm(online)
	if (!largeOrderResult.ok) return largeOrderResult
	const onlineResult = onlineFromForm(online, largeOrderResult.value)
	if (!onlineResult.success) {
		return {
			ok: false,
			error:
				onlineResult.error.issues[0]?.message ??
				'Check the online ordering settings.',
		}
	}
	patch.onlineOrderingSettings = JSON.stringify(onlineResult.data)

	const prepResult = prepFromForm(prep)
	if (!prepResult.ok) {
		return prepResult
	}
	patch.prepSchedule = JSON.stringify(prepResult.schedule)

	if (flags.slotLimits) {
		const slotResult = slotFromForm(slot)
		if (!slotResult.ok) {
			return slotResult
		}
		patch.slotLimitSettings = JSON.stringify(slotResult.settings)
	}

	if (flags.prayerPause) {
		const prayerResult = prayerFromForm(prayer)
		if (!prayerResult.ok) {
			return prayerResult
		}
		patch.prayerPauseSettings = JSON.stringify(prayerResult.settings)
	}

	return { ok: true, patch }
}
