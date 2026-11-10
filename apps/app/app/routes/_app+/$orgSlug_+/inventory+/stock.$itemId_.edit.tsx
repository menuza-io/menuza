import { Trans, useLingui } from '@lingui/react/macro'
import { INVENTORY_PERMISSIONS, itemDetailSchema } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { useNavigate, useParams } from 'react-router'
import { ItemForm } from '#app/components/inventory/item-form.tsx'
import { useStockContext } from '#app/components/inventory/stock-context.ts'
import { SheetPanel } from '#app/components/staff/sheet-frame.tsx'
import { useInventoryQuery } from '#app/hooks/use-inventory-client.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { type Route } from './+types/stock.$itemId_.edit.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug, {
		anyOf: [INVENTORY_PERMISSIONS.UPDATE_INVENTORY],
	})
	return null
}

export default function InventoryEditItemRoute() {
	const { i18n } = useLingui()
	const { itemId = '' } = useParams()
	const navigate = useNavigate()
	const ctx = useStockContext()
	const detail = useInventoryQuery(
		`/items/${encodeURIComponent(itemId)}?locationId=${encodeURIComponent(ctx.activeLocationId)}`,
		itemDetailSchema,
	)
	const backToItem = () =>
		void navigate(`${ctx.basePath}/${itemId}${ctx.search}`)

	if (detail.loading && !detail.data) {
		return (
			<SheetPanel title={<Trans>Edit item</Trans>}>
				<div role="status" className="flex flex-col gap-3">
					<span className="sr-only">
						<Trans>Loading item</Trans>
					</span>
					<Skeleton className="h-9 w-full" />
					<Skeleton className="h-9 w-full" />
				</div>
			</SheetPanel>
		)
	}
	if (!detail.data) {
		return (
			<SheetPanel title={<Trans>Edit item</Trans>}>
				<Alert variant="destructive">
					<AlertDescription>
						{i18n._(inventoryErrorMessage(detail.error))}
					</AlertDescription>
					<Button
						className="mt-2 justify-self-start"
						variant="outline"
						onClick={detail.reload}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			</SheetPanel>
		)
	}
	return (
		<ItemForm
			mode="edit"
			item={detail.data}
			locationId={ctx.activeLocationId}
			areas={ctx.areas}
			currency={ctx.currency}
			canManagePurchasing={ctx.canManagePurchasing}
			basePath={ctx.basePath}
			search={ctx.search}
			onSaved={() => {
				ctx.reload()
				backToItem()
			}}
			onCancel={backToItem}
		/>
	)
}
