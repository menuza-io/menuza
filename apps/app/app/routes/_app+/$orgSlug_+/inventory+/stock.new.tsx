import { INVENTORY_PERMISSIONS } from '@repo/inventory'
import { ItemForm } from '#app/components/inventory/item-form.tsx'
import { useStockContext } from '#app/components/inventory/stock-context.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/stock.new.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug, {
		anyOf: [INVENTORY_PERMISSIONS.UPDATE_INVENTORY],
	})
	return null
}

export default function InventoryAddItemRoute() {
	const ctx = useStockContext()
	return (
		<ItemForm
			mode="create"
			locationId={ctx.activeLocationId}
			areas={ctx.areas}
			currency={ctx.currency}
			canManagePurchasing={ctx.canManagePurchasing}
			basePath={ctx.basePath}
			search={ctx.search}
			onSaved={() => {
				ctx.reload()
				ctx.close()
			}}
			onCancel={ctx.close}
		/>
	)
}
