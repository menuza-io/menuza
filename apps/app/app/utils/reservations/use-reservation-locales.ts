import {
	DEFAULT_SITE_LOCALES,
	type SiteLocalesConfig,
} from '@repo/common/site-locales'
import { useContext } from 'react'
import { UNSAFE_DataRouterStateContext } from 'react-router'

/** The reservations layout route; its loader carries the Website settings languages. */
export const RESERVATIONS_LAYOUT_ROUTE_ID =
	'routes/_app+/$orgSlug_+/reservations+/_layout'

/**
 * The languages the organization enabled in Website settings (site locales plus
 * the default language), the same list the Menu and Drops editors use. Outside
 * the reservations layout (tests, previews) it is the platform default.
 */
export function useReservationLocales(): SiteLocalesConfig {
	// Read the router state directly: `useRouteLoaderData` throws outside a data router.
	const state = useContext(UNSAFE_DataRouterStateContext)
	const data = state?.loaderData[RESERVATIONS_LAYOUT_ROUTE_ID] as
		{ siteLocales?: SiteLocalesConfig } | undefined
	return data?.siteLocales ?? DEFAULT_SITE_LOCALES
}
