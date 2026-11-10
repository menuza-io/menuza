import { type InventoryBaseUnit, stockItemSchema } from '@repo/inventory'
import { useEffect, useState } from 'react'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'

/**
 * The base unit of each item in a list of ids, fetched once each. Supplier
 * products and delivery lines only carry the item id and a quantity in base
 * thousandths, so a pack size or an amount needs the item's unit to read.
 */
export function useItemBaseUnits(
	itemIds: readonly string[],
	locationId: string,
) {
	const { request } = useInventoryClient()
	const [units, setUnits] = useState<Record<string, InventoryBaseUnit>>({})
	const key = itemIds.join(',')
	useEffect(() => {
		const missing = itemIds.filter((id) => units[id] === undefined)
		if (missing.length === 0) return
		let live = true
		void Promise.all(
			missing.map(async (id) => {
				try {
					const parsed = stockItemSchema.safeParse(
						await request(
							`/items/${encodeURIComponent(id)}?locationId=${encodeURIComponent(locationId)}`,
						),
					)
					return parsed.success ? ([id, parsed.data.baseUnit] as const) : null
				} catch {
					return null
				}
			}),
		).then((found) => {
			if (!live) return
			setUnits((current) => ({
				...current,
				...Object.fromEntries(found.filter((entry) => entry !== null)),
			}))
		})
		return () => {
			live = false
		}
		// `key` stands for the list of ids.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key, locationId, request])
	return units
}
