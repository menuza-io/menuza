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
