import { type StorageArea } from '@repo/inventory'
import { useOutletContext } from 'react-router'
import { type InventoryLayoutContext } from '#app/routes/_app+/$orgSlug_+/inventory+/_layout.tsx'

/**
 * What the Stock tab hands to the sheets it opens (item, add, edit, add many,
 * storage areas, count lists): the layout's facts plus where to go back to
 * and how to refresh the list after a save.
 */
export type StockOutletContext = InventoryLayoutContext & {
	/** `/acme/inventory/stock` */
	basePath: string
	/** The current query string with its `?` (filters, location), kept on links. */
	search: string
	areas: readonly StorageArea[]
	/** Refetch the list and the areas, and tell the other tabs. */
	reload: () => void
	/** Close the sheet and go back to the list. */
	close: () => void
}

export function useStockContext(): StockOutletContext {
	return useOutletContext<StockOutletContext>()
}
