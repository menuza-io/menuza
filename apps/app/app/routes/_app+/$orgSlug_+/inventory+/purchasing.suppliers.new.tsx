import { INVENTORY_PERMISSIONS } from '@repo/inventory'
import { usePurchasingContext } from '#app/components/inventory/purchasing-context.ts'
import { SupplierForm } from '#app/components/inventory/supplier-form.tsx'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { type Route } from './+types/purchasing.suppliers.new.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug, {
		anyOf: [INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING],
	})
	return null
}

export default function InventoryAddSupplierRoute() {
	const ctx = usePurchasingContext()
	return (
		<SupplierForm
			mode="create"
			currency={ctx.currency}
			layout="sheet"
			onSaved={() => {
				ctx.reload()
				ctx.close()
			}}
			onCancel={ctx.close}
		/>
	)
}
