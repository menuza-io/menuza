import { createCookie } from 'react-router'

export const selectedLocationCookie = createCookie('selected-location', {
	maxAge: 31_536_000, // 1 year
	sameSite: 'lax',
	path: '/',
	httpOnly: false,
})

type LocationCookieData = Record<string, string> // { [orgSlug]: locationId }

export async function getSelectedLocation(
	request: Request,
	orgSlug: string,
): Promise<string> {
	const cookieHeader = request.headers.get('Cookie')
	const data: LocationCookieData =
		(await selectedLocationCookie.parse(cookieHeader)) || {}
	return data[orgSlug] || 'all'
}

export async function setSelectedLocation(
	request: Request,
	orgSlug: string,
	locationId: string,
): Promise<string> {
	const cookieHeader = request.headers.get('Cookie')
	const data: LocationCookieData =
		(await selectedLocationCookie.parse(cookieHeader)) || {}
	data[orgSlug] = locationId || 'all'
	return await selectedLocationCookie.serialize(data)
}
