import { pickLocalized } from '@repo/common/site-locales'
import { useRouteLoaderData } from 'react-router'

export type LocationSummary = {
	id: string
	name: string
	slug: string
	isDefault: boolean
	isActive: boolean
}

export function useLocationsData(): {
	locations: LocationSummary[]
	selectedLocationId: string
} {
	const data = useRouteLoaderData('root') as
		| {
				locations?: LocationSummary[]
				selectedLocationId?: string
		  }
		| undefined

	return {
		locations: data?.locations ?? [],
		selectedLocationId: data?.selectedLocationId ?? 'all',
	}
}

export function useSelectedLocation(): LocationSummary | null {
	const { locations, selectedLocationId } = useLocationsData()
	if (!selectedLocationId || selectedLocationId === 'all') return null
	return locations.find((loc) => loc.id === selectedLocationId) ?? null
}

export function getLocationDisplayName(
	name: string,
	locale: string = 'en',
	defaultLocale: string = 'en',
): string {
	if (!name) return ''
	const localized = pickLocalized(name, locale, defaultLocale)
	return localized || name
}
