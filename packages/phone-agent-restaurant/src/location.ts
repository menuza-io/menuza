import {
	HOURS_SCHEDULE_ONLINE,
	HOURS_SCHEDULE_PRIMARY,
	onlineAvailabilityAt,
} from '@repo/opening-hours'
import {
	type Availability,
	availabilityFromParsedHours,
	type BusinessProfile,
	defaultPriceFormatter,
	describeBusiness,
	parsedHoursFromScheduleFields,
	type PriceFormatter,
	type ScheduleDay,
	type SpecialHours,
} from '@repo/phone-agent'

/** Structural subset of the published Sites location. */
/** A delivery zone as the phone agent reads it. */
export type PhoneAgentLocationZone = {
	name: string
	enabled: boolean
	restriction: string
	type: string
	minimumOrder: number
	deliveryFee: number
	zipCodes: string[]
	radius: { value: number; unit: string }
	/** Fee by order size (#244): from this subtotal, charge this fee. */
	feeSteps?: Array<{ from: number; fee: number }>
	/** Fee by distance (#421): from this distance, charge this fee. */
	distanceFees?: {
		mode: string
		unit: string
		bands: Array<{ from: number; fee: number }>
	} | null
}

export interface AgentLocation {
	id: string
	name: string
	phone: string | null
	timezone: string
	taxRate: number
	address: { formattedAddress: string } | null
	storeHours: ScheduleDay[]
	onlineHours: ScheduleDay[]
	specialHours: SpecialHours[]
	prepTime: number
	fulfillmentOptions: {
		pickup: boolean
		delivery: boolean
		dineIn: boolean
		curbside: boolean
	}
	deliveryConfig: {
		estimatedDeliveryTimeMin: number
		estimatedDeliveryTimeMax: number
	}
	deliveryZones: PhoneAgentLocationZone[]
	/**
	 * Operator pause of online ordering (null `until`: until resumed). Absent
	 * on configs published before it existed.
	 */
	orderingPause?: { until: string | null } | null
	/** Busy mode: extra prep minutes while it lasts. */
	busyMode?: { extraPrepMinutes: number; until: string | null } | null
}

type FeeZone = PhoneAgentLocationZone

/**
 * The fee as the agent says it (#244, #421): the single fee, or the table by
 * order size and the bands by distance, in the same words the guest reads. The
 * agent never works a fee out itself; this is only what it may tell a caller.
 */
function deliveryFeeText(zone: FeeZone, formatPrice: PriceFormatter): string {
	const parts: string[] = []
	const steps = [...(zone.feeSteps ?? [])].sort((a, b) => a.from - b.from)
	const bands = [...(zone.distanceFees?.bands ?? [])].sort(
		(a, b) => a.from - b.from,
	)
	if (steps.length > 0) {
		const fee = (value: number) => (value > 0 ? formatPrice(value) : 'free')
		parts.push(
			`fee by order size: ${steps
				.map((step) => `${fee(step.fee)} from ${formatPrice(step.from)}`)
				.join(', ')}`,
		)
	}
	if (bands.length > 0 && zone.distanceFees) {
		const unit = zone.distanceFees.unit === 'miles' ? 'miles' : 'km'
		parts.push(
			`fee by distance (${zone.distanceFees.mode === 'driving' ? 'by road' : 'straight line'}): ${bands
				.map((band) => `${formatPrice(band.fee)} from ${band.from} ${unit}`)
				.join(', ')}`,
		)
	}
	return parts.length > 0 ? parts.join('; ') : `fee ${formatPrice(zone.deliveryFee)}`
}

function lastsAt(until: string | null, now: Date): boolean {
	if (until === null) return true
	const end = new Date(until).getTime()
	return !Number.isNaN(end) && end > now.getTime()
}

/**
 * True while an operator has paused online ordering, with the same rule as
 * `isOrderingPaused` in `@repo/common/location-availability`.
 */
export function orderingPausedAt(
	location: Pick<AgentLocation, 'orderingPause'>,
	now: Date,
): boolean {
	const pause = location.orderingPause
	return pause ? lastsAt(pause.until, now) : false
}

/** Pickup wait in minutes at `now`, busy mode included. */
export function currentPrepMinutes(
	location: Pick<AgentLocation, 'prepTime' | 'busyMode'>,
	now: Date,
): number {
	const busy = location.busyMode
	const extra =
		busy && busy.extraPrepMinutes > 0 && lastsAt(busy.until, now)
			? busy.extraPrepMinutes
			: 0
	return location.prepTime + extra
}

/** The location fields availability depends on. */
export type AvailabilityLocation = Pick<
	AgentLocation,
	'timezone' | 'storeHours' | 'onlineHours' | 'specialHours' | 'orderingPause'
> & {
	/** Present on published Sites locations; App treats inactive as closed. */
	isActive?: boolean | null
}

export type RestaurantAvailability = Availability & {
	/** Online ordering follows its own hours and can be paused while open. */
	orderingOpen: boolean
}

/**
 * Open/closed state at `now`, computed the way App does with
 * `isLocationOpenForOrdering` in `@repo/common/location-availability`, so
 * cached configs agree with App: `isOpen` follows store hours (falling back
 * to online hours), `orderingOpen` follows online hours and is false while an
 * operator has paused online ordering.
 */
export function restaurantAvailability(
	location: AvailabilityLocation,
	now: Date = new Date(),
): RestaurantAvailability {
	const ms = now.getTime()
	const hours = parsedHoursFromScheduleFields({
		timezone: location.timezone,
		storeHours: location.storeHours,
		onlineHours: location.onlineHours,
		specialHours: location.specialHours,
		isActive: location.isActive,
	})
	const storeKind = location.storeHours?.length
		? HOURS_SCHEDULE_PRIMARY
		: HOURS_SCHEDULE_ONLINE
	const store = availabilityFromParsedHours(hours, ms, storeKind)
	const orderingOpen =
		onlineAvailabilityAt(
			{
				timeZone: location.timezone,
				isActive: location.isActive,
				storeHours: location.storeHours,
				onlineHours: location.onlineHours,
				specialHours: location.specialHours,
			},
			ms,
			'online',
		).open && !orderingPausedAt(location, now)
	return {
		isOpen: store.isOpen,
		nextOpen: store.nextOpen,
		orderingOpen,
	}
}

/**
 * The core business profile for a location: its phone, address, and store
 * hours (online hours when it publishes no store hours).
 */
export function restaurantBusinessProfile(
	name: string,
	location: Pick<
		AgentLocation,
		| 'phone'
		| 'timezone'
		| 'address'
		| 'storeHours'
		| 'onlineHours'
		| 'specialHours'
	>,
): BusinessProfile {
	return {
		name,
		phone: location.phone,
		timezone: location.timezone,
		address: location.address?.formattedAddress || null,
		hours: location.storeHours.length
			? location.storeHours
			: location.onlineHours,
		specialHours: location.specialHours,
	}
}

/**
 * Plain-text store facts for the prompt: the business details plus pickup,
 * delivery, and delivery zones.
 */
export function describeRestaurantLocation(
	location: AgentLocation,
	now: Date,
	formatPrice: PriceFormatter = defaultPriceFormatter,
) {
	const details = describeBusiness(
		restaurantBusinessProfile(location.name, location),
		now,
	)
	const lines: string[] = details ? [details] : []

	const options = location.fulfillmentOptions
	const modes = [
		options.pickup ? 'pickup' : null,
		options.delivery ? 'delivery' : null,
		options.curbside ? 'curbside pickup' : null,
		options.dineIn ? 'dine-in' : null,
	].filter(Boolean)
	if (modes.length) lines.push(`Offers: ${modes.join(', ')}`)
	const prepMinutes = currentPrepMinutes(location, now)
	const busyExtra = prepMinutes - location.prepTime
	lines.push(
		busyExtra > 0
			? `Pickup wait right now: about ${prepMinutes} minutes (the kitchen is busy)`
			: `Typical pickup wait: about ${location.prepTime} minutes`,
	)

	if (options.delivery) {
		// Prep (busy minutes included) plus the delivery range: the same rule as
		// `deliveryArrivalWindowMinutes` in @repo/common, which ordering pages,
		// checkout and the order's promised time use.
		lines.push(
			`Typical delivery time: ${prepMinutes + location.deliveryConfig.estimatedDeliveryTimeMin} to ${prepMinutes + Math.max(location.deliveryConfig.estimatedDeliveryTimeMin, location.deliveryConfig.estimatedDeliveryTimeMax)} minutes`,
		)
		const zones = location.deliveryZones.filter(
			(zone) => zone.enabled && zone.restriction === 'allowed',
		)
		for (const zone of zones.slice(0, 6)) {
			const area =
				zone.type === 'zip_code' && zone.zipCodes.length
					? `ZIP codes ${zone.zipCodes.slice(0, 12).join(', ')}`
					: zone.type === 'radius'
						? `within ${zone.radius.value} ${zone.radius.unit}`
						: 'a mapped area'
			lines.push(
				`Delivery zone "${zone.name}": ${area}, ${deliveryFeeText(zone, formatPrice)}${
					zone.minimumOrder > 0
						? `, minimum order ${formatPrice(zone.minimumOrder)}`
						: ''
				}`,
			)
		}
	}
	return lines.join('\n')
}
