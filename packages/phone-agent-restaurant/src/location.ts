import {
	type Availability,
	availabilityFromSchedule,
	type BusinessProfile,
	defaultPriceFormatter,
	describeBusiness,
	type PriceFormatter,
	type ScheduleDay,
	type SpecialHours,
} from '@repo/phone-agent'

/** Structural subset of the published Sites location. */
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
	deliveryZones: Array<{
		name: string
		enabled: boolean
		restriction: string
		type: string
		minimumOrder: number
		deliveryFee: number
		zipCodes: string[]
		radius: { value: number; unit: string }
	}>
}

/** The location fields availability depends on. */
export type AvailabilityLocation = Pick<
	AgentLocation,
	'timezone' | 'storeHours' | 'onlineHours' | 'specialHours'
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
 * to online hours), `orderingOpen` follows online hours.
 */
export function restaurantAvailability(
	location: AvailabilityLocation,
	now: Date = new Date(),
): RestaurantAvailability {
	const base = {
		timezone: location.timezone,
		specialHours: location.specialHours,
		isActive: location.isActive,
	}
	const ordering = availabilityFromSchedule(
		{ ...base, hours: location.onlineHours ?? location.storeHours },
		now,
	)
	const store = location.storeHours?.length
		? availabilityFromSchedule({ ...base, hours: location.storeHours }, now)
		: ordering
	return {
		isOpen: store.isOpen,
		nextOpen: store.nextOpen,
		orderingOpen: ordering.isOpen,
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
	lines.push(`Typical pickup wait: about ${location.prepTime} minutes`)

	if (options.delivery) {
		lines.push(
			`Typical delivery time: ${location.deliveryConfig.estimatedDeliveryTimeMin} to ${location.deliveryConfig.estimatedDeliveryTimeMax} minutes`,
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
				`Delivery zone "${zone.name}": ${area}, fee ${formatPrice(zone.deliveryFee)}${
					zone.minimumOrder > 0
						? `, minimum order ${formatPrice(zone.minimumOrder)}`
						: ''
				}`,
			)
		}
	}
	return lines.join('\n')
}
