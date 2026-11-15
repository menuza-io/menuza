import { z } from 'zod'

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
	enabled: boolean
}

export interface DeliveryConfig {
	providers: DeliveryProvider[]
	estimatedDeliveryTimeMin: number
	estimatedDeliveryTimeMax: number
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
		if (value.defaultIndex !== null && value.defaultIndex >= value.choices.length) {
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
		choices: [{ percent: 10 }, { percent: 15 }, { percent: 18 }, { percent: 20 }],
		defaultIndex: currency.toUpperCase() === 'SAR' ? null : 1,
		allowCustom: false,
	}
}

export function defaultTipSettings(currency: string): TipSettings {
	return {
		pickup: defaultTipOrderTypeSettings(currency),
		delivery: defaultTipOrderTypeSettings(currency),
		qrTab: defaultTipOrderTypeSettings(currency),
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
		return parsed.success ? parsed.data : defaultTipOrderTypeSettings(currency)
	}
	return { pickup: pick('pickup'), delivery: pick('delivery'), qrTab: pick('qrTab') }
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
})

export * from './location-availability.ts'
export * from './location-currency.ts'
