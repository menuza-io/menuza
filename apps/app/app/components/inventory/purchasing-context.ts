import { useOutletContext } from 'react-router'
import { type InventoryLayoutContext } from '#app/routes/_app+/$orgSlug_+/inventory+/_layout.tsx'

/**
 * What the Purchasing tab hands to the sheets it opens (a supplier, a new
 * supplier, a delivery): the layout's facts plus where to go back to and how
 * to refresh the lists after a save.
 */
export type PurchasingOutletContext = InventoryLayoutContext & {
	/** `/acme/inventory/purchasing` */
	basePath: string
	/** The current query string with its `?` (location, filters), kept on links. */
	search: string
	/** Refetch the deliveries and suppliers, and tell the other tabs. */
	reload: () => void
	/** Close the sheet and go back to the list. */
	close: () => void
}

export function usePurchasingContext(): PurchasingOutletContext {
	return useOutletContext<PurchasingOutletContext>()
}
