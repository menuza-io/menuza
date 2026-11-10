import { asc, db, desc, eq, OrganizationLocation } from '@repo/database'
import {
	DEFAULT_INVENTORY_LOCATION_ID,
	INVENTORY_PERMISSIONS,
} from '@repo/inventory'
import {
	Outlet,
	useLoaderData,
	useLocation,
	useOutletContext,
	useSearchParams,
} from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	InventoryChrome,
	type InventoryChromeLocation,
} from '#app/components/inventory/inventory-chrome.tsx'
import { InventoryClientProvider } from '#app/components/inventory/inventory-client-provider.tsx'
import {
	InventoryChangeProvider,
	InventoryPrefsProvider,
} from '#app/components/inventory/inventory-prefs.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { loadUserName } from '#app/utils/inventory/actors.server.ts'
import {
	computeInventoryNavAccess,
	type InventoryNavAccess,
	isInventoryFullPage,
} from '#app/utils/inventory/nav.ts'
import {
	displayLocationName,
	orgSiteLocales,
} from '#app/utils/location-name.server.ts'
import { type Route } from './+types/_layout.ts'

export type InventoryLayoutContext = {
	orgSlug: string
	nav: InventoryNavAccess
	locations: InventoryChromeLocation[]
	/** The location every tab reads and writes (never empty). */
	activeLocationId: string
	/** Whether the member may see money figures. */
	canSeeCost: boolean
	/** Whether the member may change items, areas, counts and waste. */
	canEdit: boolean
	/** Whether the member may also set prices and suppliers. */
	canManagePurchasing: boolean
	/** The `inventory.purchasing` flag: levels, suggested orders and sending orders. */
	purchasingEnabled: boolean
	/** The `inventory.transfers` flag: moving stock between places, branch requests, comparison. */
	transfersEnabled: boolean
	/**
	 * Every place of the organization (names only), for the "other place" of a
	 * transfer: a member may see fewer places than they can move stock to or from.
	 * Empty unless transfers are on.
	 */
	transferPlaces: InventoryChromeLocation[]
	/** The data region, which sets the default unit system. */
	dataRegion: 'us' | 'ksa'
	/** The currency money figures are entered in. */
	currency: string
	/** The signed-in member's display name ("Logged as Sara"). */
	userName: string
}

export function useInventoryLayoutData(): InventoryLayoutContext {
	return useOutletContext<InventoryLayoutContext>()
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug)
	const nav = computeInventoryNavAccess(access.features, access.grants)

	const [locationRows, { defaultLocale }, userName] = await Promise.all([
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, access.organizationId))
			.orderBy(
				desc(OrganizationLocation.isDefault),
				asc(OrganizationLocation.createdAt),
			),
		orgSiteLocales(access.organizationId),
		loadUserName(access.userId),
	])

	// An organization without locations keeps its stock at the implicit
	// location `main`, named after the organization.
	const locations: InventoryChromeLocation[] =
		locationRows.length === 0
			? [{ id: DEFAULT_INVENTORY_LOCATION_ID, name: access.organizationName }]
			: (access.locationIds === null
					? locationRows
					: locationRows.filter((loc) => access.locationIds!.includes(loc.id))
				).map((loc) => ({
					id: loc.id,
					name: displayLocationName(loc.name, defaultLocale, defaultLocale),
				}))
	if (locations.length === 0) {
		throw new Response('Forbidden: no inventory locations', { status: 403 })
	}

	return {
		orgSlug: access.organizationSlug,
		nav,
		locations,
		canSeeCost: access.grants.includes(
			INVENTORY_PERMISSIONS.READ_INVENTORY_COST,
		),
		// Support impersonation may look but never change anything.
		canEdit:
			!access.impersonated &&
			access.grants.includes(INVENTORY_PERMISSIONS.UPDATE_INVENTORY),
		canManagePurchasing:
			!access.impersonated &&
			access.grants.includes(INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING),
		purchasingEnabled: access.features.purchasing,
		transfersEnabled: access.features.transfers,
		transferPlaces: access.features.transfers
			? locationRows.map((loc) => ({
					id: loc.id,
					name: displayLocationName(loc.name, defaultLocale, defaultLocale),
				}))
			: [],
		dataRegion: access.dataRegion,
		currency: access.currency,
		userName,
	}
}

export default function InventoryLayout() {
	const {
		orgSlug,
		nav,
		locations,
		canSeeCost,
		canEdit,
		canManagePurchasing,
		purchasingEnabled,
		transfersEnabled,
		transferPlaces,
		dataRegion,
		currency,
		userName,
	} = useLoaderData<typeof loader>()
	const [searchParams, setSearchParams] = useSearchParams()
	const { pathname } = useLocation()
	// Counting, a count's review and a new delivery bring their own header.
	const fullPage = isInventoryFullPage(pathname, orgSlug)

	const requested = searchParams.get('locationId')
	const activeLocationId =
		locations.find((loc) => loc.id === requested)?.id ?? locations[0]!.id

	const onLocationChange = (locationId: string) => {
		const next = new URLSearchParams(searchParams)
		if (locationId === locations[0]?.id) next.delete('locationId')
		else next.set('locationId', locationId)
		setSearchParams(next, { replace: true })
	}

	const context: InventoryLayoutContext = {
		orgSlug,
		nav,
		locations,
		activeLocationId,
		canSeeCost,
		canEdit,
		canManagePurchasing,
		purchasingEnabled,
		transfersEnabled,
		transferPlaces,
		dataRegion,
		currency,
		userName,
	}

	return (
		<InventoryClientProvider orgSlug={orgSlug}>
			<InventoryChangeProvider>
				<InventoryPrefsProvider dataRegion={dataRegion}>
					{fullPage ? (
						<Outlet context={context} />
					) : (
						<InventoryChrome
							orgSlug={orgSlug}
							nav={nav}
							locations={locations}
							selectedLocationId={activeLocationId}
							onLocationChange={onLocationChange}
							canLogWaste={canEdit}
							canSeeCost={canSeeCost}
							currency={currency}
							userName={userName}
						>
							<Outlet context={context} />
						</InventoryChrome>
					)}
				</InventoryPrefsProvider>
			</InventoryChangeProvider>
		</InventoryClientProvider>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
