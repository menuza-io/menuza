import { z } from 'zod'

/**
 * Own-driver deliveries (#287) and the driver report (#324): the contract shared
 * by tenant-api, the App Orders board and Station. Pure: no I/O, no UI words.
 *
 * A run is a driver taking one or several ready delivery orders. The driver's
 * phone sees only that run's stops while it is open; a manager sees the board.
 * Guest names, phones and addresses live on the order in the region and are read
 * from it while a run is open: a run never copies them, and the report shows
 * zones only.
 */

/** Org flag (default off, only a literal `true`). */
export const DELIVERY_IN_HOUSE_FLAG_KEY = 'delivery.in_house'

export const MAX_STOPS_PER_RUN = 12

export const DELIVERY_RUN_STATUSES = [
	'assigned',
	'on_the_road',
	'completed',
	'cancelled',
] as const
export type DeliveryRunStatusValue = (typeof DELIVERY_RUN_STATUSES)[number]

export const DELIVERY_STOP_STATUSES = [
	'pending',
	'picked_up',
	'delivered',
	'problem',
	'released',
] as const
export type DeliveryStopStatusValue = (typeof DELIVERY_STOP_STATUSES)[number]

export const DELIVERY_PROBLEM_KINDS = [
	'not_home',
	'wrong_address',
	'refused',
	'cannot_reach',
	'other',
] as const
export type DeliveryProblemKindValue = (typeof DELIVERY_PROBLEM_KINDS)[number]

export const DELIVERY_PROBLEM_LABELS: Record<DeliveryProblemKindValue, string> =
	{
		not_home: 'Nobody home',
		wrong_address: 'Wrong address',
		refused: 'Guest refused',
		cannot_reach: 'Cannot reach the guest',
		other: 'Other problem',
	}

/** Whether a run still has the driver out with addresses on their device. */
export function isOpenRunStatus(status: string): boolean {
	return status === 'assigned' || status === 'on_the_road'
}

const idSchema = z.string().trim().min(1).max(100)

/** Manager: send ready orders out as one run with a driver. */
export const deliveryRunCreateSchema = z.strictObject({
	locationId: idSchema,
	driverStaffId: idSchema,
	orderIds: z.array(idSchema).min(1).max(MAX_STOPS_PER_RUN),
})
export type DeliveryRunCreate = z.infer<typeof deliveryRunCreateSchema>

/** Driver: take ready orders for myself. */
export const deliveryClaimSchema = z.strictObject({
	orderIds: z.array(idSchema).min(1).max(MAX_STOPS_PER_RUN),
})

/** Manager: give a whole open run to another driver. */
export const deliveryReassignSchema = z.strictObject({
	driverStaffId: idSchema,
})

export const deliveryAvailabilitySchema = z.strictObject({
	unavailable: z.boolean(),
})

/** A delivered stop; the cash is what the driver says they collected. */
export const deliveryStopDeliveredSchema = z.strictObject({
	cashCollectedCents: z.number().int().min(0).max(100_000_000).optional(),
})

export const deliveryStopProblemSchema = z.strictObject({
	kind: z.enum(DELIVERY_PROBLEM_KINDS),
})

/** The driver's own position, shared on purpose while a run is open. */
export const deliveryPositionSchema = z.strictObject({
	lat: z.number().min(-90).max(90),
	lng: z.number().min(-180).max(180),
})

export const deliveryBoardQuerySchema = z.strictObject({
	locationId: idSchema,
})

/** A ready delivery order waiting for a driver (the board: managers only). */
export type DeliveryBoardOrder = {
	id: string
	number: string
	/** The guest's first name; never the surname, phone or email. */
	firstName: string
	address: string
	unit: string | null
	zoneName: string | null
	promisedAt: number | null
	readyAt: number | null
	cashDueCents: number
	tipCents: number
	currency: string
}

export type DeliveryStopView = {
	id: string
	orderId: string
	number: string
	stopNo: number
	status: DeliveryStopStatusValue
	problemKind: DeliveryProblemKindValue | null
	firstName: string
	address: string
	unit: string | null
	notes: string | null
	/** A map link built from the address; the driver's phone opens it. */
	mapUrl: string
	cashDueCents: number
	cashCollectedCents: number
	tipCents: number
	currency: string
	/** The guest has a phone and the masked call is available here. */
	canCall: boolean
}

export type DeliveryRunView = {
	id: string
	status: DeliveryRunStatusValue
	locationId: string
	driver: { staffId: string; name: string }
	createdByKind: 'manager' | 'driver'
	createdAt: number
	pickedUpAt: number | null
	stops: DeliveryStopView[]
	/** The driver's shared position while the run is open; null when not shared. */
	position: { lat: number; lng: number; updatedAt: number } | null
}

export type DeliveryDriverView = {
	staffId: string
	/** Staff name: first name and the last initial. */
	name: string
	unavailable: boolean
	/** Open runs the driver holds now. */
	openRuns: number
}

export type DeliveryBoard = {
	locationId: string
	unassigned: DeliveryBoardOrder[]
	runs: DeliveryRunView[]
	drivers: DeliveryDriverView[]
}

/** What the driver's own device gets: their run and nothing of anyone else's. */
export type DriverSelf = {
	role: 'manager' | 'driver' | 'none'
	/** A manager who also drives sees the board and their own run. */
	isDriver: boolean
	unavailable: boolean
	/** Ready delivery orders a driver may claim; empty for a plain manager. */
	claimable: DeliveryBoardOrder[]
	run: DeliveryRunView | null
}

/** Google Maps directions-free search link for an address (no API, no key). */
export function mapUrlForAddress(address: string, unit: string | null): string {
	const text = [address, unit].filter(Boolean).join(' ')
	return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}`
}

/** Cash a driver collects for an order: pay at handoff, unpaid, less a gift card. */
export function cashDueFor(order: {
	paymentMethod: string
	paymentStatus: string
	totalCents: number
	giftCardCents?: number
}): number {
	if (order.paymentMethod !== 'handoff' || order.paymentStatus !== 'unpaid') {
		return 0
	}
	return Math.max(0, order.totalCents - (order.giftCardCents ?? 0))
}

/** "Rana K." from a staff member: first name and the last initial. */
export function driverDisplayName(firstName: string, lastName: string): string {
	const initial = lastName.trim().charAt(0)
	return initial ? `${firstName.trim()} ${initial.toUpperCase()}.` : firstName.trim()
}
