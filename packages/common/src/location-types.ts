import { z } from 'zod'

import {
	DeliveryDistanceFeesSchema,
	DeliveryFeeStepSchema,
	type DeliveryDistanceFees,
	type DeliveryFeeStep,
} from './delivery-fees.ts'

export const DAYS_OF_WEEK = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
] as const

export type DayOfWeek = (typeof DAYS_OF_WEEK)[number]

export const DAY_LABELS: Record<DayOfWeek, string> = {
	monday: 'Monday',
	tuesday: 'Tuesday',
	wednesday: 'Wednesday',
	thursday: 'Thursday',
	friday: 'Friday',
	saturday: 'Saturday',
	sunday: 'Sunday',
}

export const SHORT_DAY_LABELS: Record<DayOfWeek, string> = {
	monday: 'Mon',
	tuesday: 'Tue',
	wednesday: 'Wed',
	thursday: 'Thu',
	friday: 'Fri',
	saturday: 'Sat',
	sunday: 'Sun',
}

export interface TimeSlot {
	start: string // "09:00"
	end: string // "17:00"
}

export interface DaySchedule {
	day: DayOfWeek
	isOpen: boolean
	slots: TimeSlot[]
}

export type WeeklySchedule = DaySchedule[]

export interface SpecialHour {
	id: string
	date: string // "YYYY-MM-DD"
	isOpen: boolean
	slots: TimeSlot[]
	note?: string
	/**
	 * Repeats on this month and day of every later year (#242). Moving holidays
	 * stay one-off. Optional and additive: absent means a one-off entry.
	 */
	repeatsYearly?: boolean
}

export interface LocationAddress {
	formattedAddress: string
	streetNumber?: string
	streetName?: string
	unit?: string
	city: string
	state: string
	postalCode: string
	country: string
	lat: number
	lng: number
}

export interface FulfillmentOptions {
	pickup: boolean
	delivery: boolean
	dineIn: boolean
	curbside: boolean
}

export interface InHouseTips {
	pickupTips: boolean
	deliveryTips: boolean
	dineInTips: boolean
}

export interface SchedulingOptions {
	scheduledOrdersEnabled: boolean
	advanceOrderDays: number
}

export type DeliveryProvider =
	'in_house' | 'uber_eats' | 'doordash' | 'restricted'
export type DeliveryZoneType = 'radius' | 'zip_code' | 'polygon'
export type DeliveryRestriction = 'allowed' | 'disallowed'

export interface DeliveryPoint {
	lat: number
	lng: number
}

export interface DeliveryZone {
	id: string
	name: string
	provider: DeliveryProvider
	restriction: DeliveryRestriction
	type: DeliveryZoneType
	radius: {
		value: number
		unit: 'miles' | 'km'
	}
	zipCodes: string[]
	polygon: DeliveryPoint[]
	minimumOrder: number // In dollars / main currency units
	deliveryFee: number // In dollars / main currency units
	/**
	 * Fee by order size (#244): from this subtotal, charge this fee. Absent or
	 * empty keeps the single `deliveryFee`. The first step starts at the
	 * zone's minimum order.
	 */
	feeSteps?: DeliveryFeeStep[]
	/**
	 * Fee by distance (#421): bands measured in straight line or by road. Absent
	 * or empty keeps the single `deliveryFee`.
	 */
	distanceFees?: DeliveryDistanceFees | null
	enabled: boolean
}

/**
 * Which zone wins when zones overlap (#266): `cheapest` (a location nobody has
 * reordered) or `order` (the first zone in the list that covers the address).
 */
export const ZONE_PRIORITY_VALUES = ['cheapest', 'order'] as const
export type ZonePriorityMode = (typeof ZONE_PRIORITY_VALUES)[number]

export interface DeliveryConfig {
	providers: DeliveryProvider[]
	estimatedDeliveryTimeMin: number
	estimatedDeliveryTimeMax: number
	/** Missing is `cheapest`, so a location that was never reordered is unchanged. */
	zonePriority?: ZonePriorityMode
}

export const DEFAULT_WEEKLY_SCHEDULE: WeeklySchedule = [
	{
		day: 'monday',
		isOpen: true,
		slots: [{ start: '09:00', end: '21:00' }],
	},
	{
		day: 'tuesday',
		isOpen: true,
		slots: [{ start: '09:00', end: '21:00' }],
	},
	{
		day: 'wednesday',
		isOpen: true,
		slots: [{ start: '09:00', end: '21:00' }],
	},
	{
		day: 'thursday',
		isOpen: true,
		slots: [{ start: '09:00', end: '21:00' }],
	},
	{
		day: 'friday',
		isOpen: true,
		slots: [{ start: '09:00', end: '22:00' }],
	},
	{
		day: 'saturday',
		isOpen: true,
		slots: [{ start: '10:00', end: '22:00' }],
	},
	{
		day: 'sunday',
		isOpen: true,
		slots: [{ start: '10:00', end: '20:00' }],
	},
]

export const DEFAULT_FULFILLMENT_OPTIONS: FulfillmentOptions = {
	pickup: true,
	delivery: true,
	dineIn: true,
	curbside: false,
}

export const DEFAULT_IN_HOUSE_TIPS: InHouseTips = {
	pickupTips: true,
	deliveryTips: true,
	dineInTips: true,
}

export const DEFAULT_SCHEDULING: SchedulingOptions = {
	scheduledOrdersEnabled: true,
	advanceOrderDays: 7,
}

export const DEFAULT_DELIVERY_CONFIG: DeliveryConfig = {
	providers: ['in_house', 'uber_eats', 'doordash'],
	estimatedDeliveryTimeMin: 25,
	estimatedDeliveryTimeMax: 45,
}

export const DEFAULT_DELIVERY_ZONE: DeliveryZone = {
	id: 'default-radius-zone',
	name: 'Standard Delivery Area',
	provider: 'in_house',
	restriction: 'allowed',
	type: 'radius',
	radius: {
		value: 5,
		unit: 'miles',
	},
	zipCodes: [],
	polygon: [],
	minimumOrder: 15,
	deliveryFee: 3.99,
	enabled: true,
}

// Zod Schemas
export const TimeSlotSchema = z.object({
	start: z
		.string()
		.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Invalid time format (HH:MM)'),
	end: z
		.string()
		.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Invalid time format (HH:MM)'),
})

export const DayScheduleSchema = z.object({
	day: z.enum(DAYS_OF_WEEK),
	isOpen: z.boolean(),
	slots: z.array(TimeSlotSchema),
})

export const WeeklyScheduleSchema = z.array(DayScheduleSchema)

export const SpecialHourSchema = z.object({
	id: z.string(),
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD)'),
	isOpen: z.boolean(),
	slots: z.array(TimeSlotSchema),
	note: z.string().optional(),
	repeatsYearly: z.boolean().optional(),
})

export const LocationAddressSchema = z.object({
	formattedAddress: z.string().min(1, 'Address is required'),
	streetNumber: z.string().optional(),
	streetName: z.string().optional(),
	unit: z.string().optional(),
	city: z.string().min(1, 'City is required'),
	state: z.string().min(1, 'State is required'),
	postalCode: z.string().min(1, 'Postal code is required'),
	country: z.string().min(1, 'Country is required'),
	lat: z.number(),
	lng: z.number(),
})

export const DeliveryPointSchema = z.object({
	lat: z.number(),
	lng: z.number(),
})

export const DeliveryZoneSchema = z.object({
	id: z.string(),
	name: z.string().min(1, 'Zone name is required'),
	provider: z.enum(['in_house', 'uber_eats', 'doordash', 'restricted']),
	restriction: z.enum(['allowed', 'disallowed']),
	type: z.enum(['radius', 'zip_code', 'polygon']),
	radius: z.object({
		value: z.number().min(0.1),
		unit: z.enum(['miles', 'km']),
	}),
	zipCodes: z.array(z.string()),
	polygon: z.array(DeliveryPointSchema),
	minimumOrder: z.number().min(0),
	deliveryFee: z.number().min(0),
	feeSteps: z.array(DeliveryFeeStepSchema).max(10).optional(),
	distanceFees: DeliveryDistanceFeesSchema.nullable().optional(),
	enabled: z.boolean(),
})

export const FulfillmentOptionsSchema = z.object({
	pickup: z.boolean(),
	delivery: z.boolean(),
	dineIn: z.boolean(),
	curbside: z.boolean(),
})

export const InHouseTipsSchema = z.object({
	pickupTips: z.boolean(),
	deliveryTips: z.boolean(),
	dineInTips: z.boolean(),
})

// ---------------------------------------------------------------------------
// Tip choices at online checkout (#118)
// ---------------------------------------------------------------------------

/** One button: a share of the subtotal or a fixed amount (minor units). */
export const TipChoiceSchema = z.union([
	z.strictObject({ percent: z.number().int().min(1).max(30) }),
	z.strictObject({ amountMinor: z.number().int().min(1).max(1_000_000) }),
])
export type TipChoice = z.infer<typeof TipChoiceSchema>

export const MAX_TIP_CHOICES = 4

/** The buttons of one order type (pickup, delivery or the QR tab). */
export const TipOrderTypeSettingsSchema = z
	.strictObject({
		/** Up to four, in the order shown. */
		choices: z.array(TipChoiceSchema).max(MAX_TIP_CHOICES),
		/** Index into `choices` that starts selected; null starts on no tip. */
		defaultIndex: z.number().int().min(0).nullable(),
		/** Show "Custom", which opens an amount field. */
		allowCustom: z.boolean(),
	})
	.superRefine((value, context) => {
		if (
			value.defaultIndex !== null &&
			value.defaultIndex >= value.choices.length
		) {
			context.addIssue({
				code: 'custom',
				path: ['defaultIndex'],
				message: 'The default must be one of the choices',
			})
		}
		const keys = value.choices.map((choice) =>
			'percent' in choice ? `p${choice.percent}` : `a${choice.amountMinor}`,
		)
		if (new Set(keys).size !== keys.length) {
			context.addIssue({
				code: 'custom',
				path: ['choices'],
				message: 'Each choice once',
			})
		}
		if (value.choices.length === 0 && !value.allowCustom) {
			context.addIssue({
				code: 'custom',
				path: ['choices'],
				message: 'Add a choice or allow a custom amount',
			})
		}
	})
export type TipOrderTypeSettings = z.infer<typeof TipOrderTypeSettingsSchema>

/** `OrganizationLocation.tipSettings`: per order type. */
export const TipSettingsSchema = z.strictObject({
	pickup: TipOrderTypeSettingsSchema,
	delivery: TipOrderTypeSettingsSchema,
	qrTab: TipOrderTypeSettingsSchema,
})
export type TipSettings = z.infer<typeof TipSettingsSchema>
export type TipOrderType = keyof TipSettings

/**
 * What a location shows when it has saved nothing: the old 10, 15, 18 and 20
 * percent buttons with 15 selected. A SAR location starts with no tip
 * selected (tipping is less common there). No custom amount until an
 * operator turns it on.
 */
export function defaultTipOrderTypeSettings(
	currency: string,
): TipOrderTypeSettings {
	return {
		choices: [
			{ percent: 10 },
			{ percent: 15 },
			{ percent: 18 },
			{ percent: 20 },
		],
		defaultIndex: currency.toUpperCase() === 'SAR' ? null : 1,
		allowCustom: false,
	}
}

/**
 * A table tab keeps the buttons it always had (10, 15 and 20 percent, none
 * selected) until an operator saves others.
 */
export function defaultQrTabTipSettings(): TipOrderTypeSettings {
	return {
		choices: [{ percent: 10 }, { percent: 15 }, { percent: 20 }],
		defaultIndex: null,
		allowCustom: false,
	}
}

export function defaultTipSettings(currency: string): TipSettings {
	return {
		pickup: defaultTipOrderTypeSettings(currency),
		delivery: defaultTipOrderTypeSettings(currency),
		qrTab: defaultQrTabTipSettings(),
	}
}

/**
 * Reads a stored value (a JSON string, an object or nothing) into settings. An
 * order type that is missing or unreadable falls back to the default, so a bad
 * row never removes tipping.
 */
export function resolveTipSettings(
	raw: unknown,
	currency: string,
): TipSettings {
	let value: unknown = raw
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw)
		} catch {
			value = null
		}
	}
	const record =
		value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
	const pick = (key: TipOrderType) => {
		const parsed = TipOrderTypeSettingsSchema.safeParse(record[key])
		if (parsed.success) return parsed.data
		return key === 'qrTab'
			? defaultQrTabTipSettings()
			: defaultTipOrderTypeSettings(currency)
	}
	return {
		pickup: pick('pickup'),
		delivery: pick('delivery'),
		qrTab: pick('qrTab'),
	}
}

export const SchedulingOptionsSchema = z.object({
	scheduledOrdersEnabled: z.boolean(),
	advanceOrderDays: z.number().min(1).max(90),
})

export const DeliveryConfigSchema = z.object({
	providers: z.array(
		z.enum(['in_house', 'uber_eats', 'doordash', 'restricted']),
	),
	estimatedDeliveryTimeMin: z.number().min(5),
	estimatedDeliveryTimeMax: z.number().min(5),
	zonePriority: z.enum(ZONE_PRIORITY_VALUES).optional(),
})

// ---------------------------------------------------------------------------
// Online ordering hours, buffers (#330) and slot limits (#108, #256)
// ---------------------------------------------------------------------------

export const OnlineOrderingBuffersSchema = z.strictObject({
	openingBufferMinutes: z.number().int().min(0).max(120).default(0),
	closingBufferMinutes: z.number().int().min(0).max(120).default(0),
})
export type OnlineOrderingBuffers = z.infer<typeof OnlineOrderingBuffersSchema>

export const FulfillmentHoursModeSchema = z.enum([
	'follow_online',
	'custom',
	'closed',
])
export type FulfillmentHoursMode = z.infer<typeof FulfillmentHoursModeSchema>

export const OnlineOrderingUtensilsSchema = z.strictObject({
	enabled: z.boolean().default(false),
	defaultRequested: z.boolean().default(false),
})

/**
 * Large orders (#355): "more than N items or over AMOUNT, add M minutes". Both
 * thresholds are optional, whichever is reached first applies. Present (even
 * with both empty, meaning no rule) it replaces the single threshold the
 * location columns held before.
 */
export const OnlineOrderingLargeOrderSchema = z.strictObject({
	itemThreshold: z.number().int().positive().max(1000).nullable(),
	/** Minor units of the location's currency. */
	amountMinor: z.number().int().positive().max(1_000_000_000).nullable(),
	extraMinutes: z.number().int().min(0).max(240),
})
export type OnlineOrderingLargeOrder = z.infer<
	typeof OnlineOrderingLargeOrderSchema
>

export const OnlineOrderingSettingsSchema = z.strictObject({
	buffers: OnlineOrderingBuffersSchema,
	pickup: FulfillmentHoursModeSchema.default('follow_online'),
	delivery: FulfillmentHoursModeSchema.default('follow_online'),
	catering: FulfillmentHoursModeSchema.default('follow_online'),
	/** When true, `onlineHours` on the location follows `storeHours`. */
	syncOnlineWithStore: z.boolean().default(true),
	/** Ask for utensils on pickup and delivery (#257). */
	utensils: OnlineOrderingUtensilsSchema.optional(),
	/** The large-order extra time rule (#355). */
	largeOrder: OnlineOrderingLargeOrderSchema.optional(),
})
export type OnlineOrderingSettings = z.infer<
	typeof OnlineOrderingSettingsSchema
>

export const SLOT_LIMIT_UNIT_SCHEMA = z.enum(['orders', 'dishes'])
export type SlotLimitUnit = z.infer<typeof SLOT_LIMIT_UNIT_SCHEMA>

export const SlotLimitSettingsSchema = z
	.strictObject({
		enabled: z.boolean().default(false),
		unit: SLOT_LIMIT_UNIT_SCHEMA.default('orders'),
		/** Blank at the form means unlimited (`null`). */
		defaultLimit: z.number().int().min(1).max(500).nullable(),
		pickupLimit: z.number().int().min(1).max(500).nullable().optional(),
		deliveryLimit: z.number().int().min(1).max(500).nullable().optional(),
		allowOneLargeOrderPerSlot: z.boolean().default(false),
	})
	.superRefine((value, ctx) => {
		if (!value.enabled) return
		const limit = value.pickupLimit ?? value.deliveryLimit ?? value.defaultLimit
		if (limit == null) {
			ctx.addIssue({
				code: 'custom',
				path: ['defaultLimit'],
				message: 'Set a limit or turn slot limits off',
			})
		}
	})
export type SlotLimitSettings = z.infer<typeof SlotLimitSettingsSchema>

export const PREP_SCHEDULE_SLOT_MINUTES = 15

const hhmmQuarter = z
	.string()
	.regex(/^([01]\d|2[0-3]):(00|15|30|45)$/, 'Use 15-minute steps (HH:MM)')

export const PrepScheduleRowSchema = z.strictObject({
	days: z.array(z.enum(DAYS_OF_WEEK)).min(1),
	from: hhmmQuarter,
	to: hhmmQuarter,
	minutes: z.number().int().min(0).max(180),
})
export type PrepScheduleRow = z.infer<typeof PrepScheduleRowSchema>

export const PrepScheduleSchema = z
	.array(PrepScheduleRowSchema)
	.max(24)
	.superRefine((rows, ctx) => {
		for (let i = 0; i < rows.length; i += 1) {
			for (let j = i + 1; j < rows.length; j += 1) {
				const a = rows[i]!
				const b = rows[j]!
				const sharedDay = a.days.some((day) => b.days.includes(day))
				if (!sharedDay) continue
				if (!(a.to <= b.from || b.to <= a.from)) {
					ctx.addIssue({
						code: 'custom',
						path: [j],
						message: `Overlaps row ${i + 1} (${a.from}–${a.to} and ${b.from}–${b.to})`,
					})
				}
			}
		}
	})
export type PrepSchedule = z.infer<typeof PrepScheduleSchema>

export const PrayerPauseSettingsSchema = z.strictObject({
	enabled: z.boolean().default(false),
	calculationMethod: z
		.enum(['UmmAlQura', 'MuslimWorldLeague', 'Egyptian'])
		.default('UmmAlQura'),
	prayers: z
		.array(
			z.strictObject({
				name: z.enum(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']),
				beforeMinutes: z.number().int().min(0).max(60).default(5),
				afterMinutes: z.number().int().min(0).max(60).default(15),
			}),
		)
		.default([]),
})
export type PrayerPauseSettings = z.infer<typeof PrayerPauseSettingsSchema>

export * from './location-availability.ts'
export * from './location-currency.ts'
