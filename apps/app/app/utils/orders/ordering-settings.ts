/**
 * Location settings for online ordering hours modes, buffers (#330), slot
 * limits (#108), variable prep windows, and prayer pauses. Form state is JSON
 * in the posted payload; this file parses it into `OrganizationLocation` text
 * columns. Slot limits and prayer pause groups are skipped when their org flag
 * is off so a stale form cannot change them.
 */
import {
	FulfillmentHoursModeSchema,
	type FulfillmentHoursMode,
	OnlineOrderingSettingsSchema,
	type PrayerPauseSettings,
	PrayerPauseSettingsSchema,
	PrepScheduleSchema,
	SlotLimitSettingsSchema,
} from '@repo/common/location-types'
import {
	parseLocationPrepSchedule,
	parseOnlineOrderingSettings,
	parsePrayerPauseSettings,
	parseSlotLimitSettings,
} from '@repo/common/location-settings'
import { z } from 'zod'

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
): OnlineOrderingFormValues {
	const parsed = parseOnlineOrderingSettings(raw)
	if (!parsed) return defaultOnlineOrderingForm()
	return {
		openingBufferMinutes: String(parsed.buffers.openingBufferMinutes),
		closingBufferMinutes: String(parsed.buffers.closingBufferMinutes),
		pickup: parsed.pickup,
		delivery: parsed.delivery,
		catering: parsed.catering,
		syncOnlineWithStore: parsed.syncOnlineWithStore,
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
}): OrderingSettingsFormBundle {
	return {
		online: onlineOrderingFormFromRecord(record.onlineOrderingSettings),
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

function onlineFromForm(values: OnlineOrderingFormValues) {
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

	const onlineResult = onlineFromForm(online)
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
