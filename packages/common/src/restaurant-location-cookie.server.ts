import { createCookie } from 'react-router'

/** Per-organization selected restaurant location (control-plane OrganizationLocation id). */
export type RestaurantLocationCookieMap = Record<string, string>

export const restaurantLocationCookie = createCookie(
	'menuza-restaurant-location',
	{
		maxAge: 31_536_000,
		sameSite: 'lax',
		path: '/',
		httpOnly: true,
	},
)

export async function parseRestaurantLocationCookie(
	request: Request,
): Promise<RestaurantLocationCookieMap> {
	const cookieHeader = request.headers.get('Cookie')
	const parsed = (await restaurantLocationCookie.parse(cookieHeader)) as
		RestaurantLocationCookieMap | undefined
	if (!parsed || typeof parsed !== 'object') return {}
	return parsed
}

/**
 * Returns the selected location id for an org, or null when the operator is in
 * brand-level context (no specific branch selected).
 */
export async function getSelectedRestaurantLocationId(
	request: Request,
	organizationId: string,
): Promise<string | null> {
	const map = await parseRestaurantLocationCookie(request)
	const value = map[organizationId]
	return typeof value === 'string' && value.length > 0 ? value : null
}

export async function serializeRestaurantLocationCookie(
	map: RestaurantLocationCookieMap,
): Promise<string> {
	return restaurantLocationCookie.serialize(map)
}

export async function setSelectedRestaurantLocationId(
	request: Request,
	organizationId: string,
	locationId: string | null,
): Promise<string> {
	const map = await parseRestaurantLocationCookie(request)
	if (locationId) {
		map[organizationId] = locationId
	} else {
		delete map[organizationId]
	}
	return serializeRestaurantLocationCookie(map)
}
