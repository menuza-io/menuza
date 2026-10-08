import { z } from 'zod'
import { type PhoneAgentRuntimeConfig } from '@repo/phone-agent'
import {
	type AgentLocation,
	type AvailabilityLocation,
	restaurantAvailability,
	restaurantBusinessProfile,
} from './location.ts'
import { type AgentMenu } from './menu.ts'

export const RESTAURANT_VERTICAL_ID = 'restaurant'

/** `PhoneAgentRuntimeConfig.vertical.data` for the restaurant vertical. */
export type RestaurantVerticalData = {
	/** The location the call is for; its id is the config's `scopeId`. */
	location: AgentLocation
	menus: AgentMenu[]
	/** Online ordering open at config time; recomputed at call time. */
	orderingOpen: boolean
}

/**
 * A shape check only: the location and menus are the published Sites
 * payload, which App passes as-is.
 */
export const RestaurantVerticalDataSchema = z.object({
	location: z
		.object({ id: z.string().min(1), name: z.string(), timezone: z.string() })
		.passthrough(),
	menus: z.array(z.object({ id: z.string() }).passthrough()),
	orderingOpen: z.boolean(),
})

export function parseRestaurantData(value: unknown): RestaurantVerticalData {
	RestaurantVerticalDataSchema.parse(value)
	return value as RestaurantVerticalData
}

/** The restaurant data of a config built for this vertical. */
export function restaurantDataOf(
	config: Pick<PhoneAgentRuntimeConfig, 'vertical'>,
): RestaurantVerticalData {
	if (config.vertical.id !== RESTAURANT_VERTICAL_ID) {
		throw new Error(`Expected a restaurant config, got "${config.vertical.id}"`)
	}
	return parseRestaurantData(config.vertical.data)
}

/**
 * The location-dependent parts of a runtime config. App spreads them into
 * the rest of the config it builds.
 */
export function restaurantConfigParts(input: {
	businessName: string
	location: AgentLocation & Pick<AvailabilityLocation, 'isActive'>
	menus: AgentMenu[]
	now?: Date
}): Pick<
	PhoneAgentRuntimeConfig,
	'scopeId' | 'business' | 'availability' | 'vertical'
> {
	const availability = restaurantAvailability(input.location, input.now)
	const data: RestaurantVerticalData = {
		location: input.location,
		menus: input.menus,
		orderingOpen: availability.orderingOpen,
	}
	return {
		scopeId: input.location.id,
		business: restaurantBusinessProfile(input.businessName, input.location),
		availability: {
			isOpen: availability.isOpen,
			nextOpen: availability.nextOpen,
		},
		vertical: { id: RESTAURANT_VERTICAL_ID, data },
	}
}
