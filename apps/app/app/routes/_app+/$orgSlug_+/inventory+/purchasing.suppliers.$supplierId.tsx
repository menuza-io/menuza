import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { supplierDetailSchema, type Supplier } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { useState } from 'react'
import { useParams } from 'react-router'
import { toast } from 'sonner'
import { useNotifyInventoryChanged } from '#app/components/inventory/inventory-prefs.tsx'
import { usePurchasingContext } from '#app/components/inventory/purchasing-context.ts'
import {
	SupplierForm,
	weekdayName,
} from '#app/components/inventory/supplier-form.tsx'
import { SupplierProducts } from '#app/components/inventory/supplier-products.tsx'
import { SheetPanel } from '#app/components/staff/sheet-frame.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import { type Route } from './+types/purchasing.suppliers.$supplierId.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug)
	return null
}

/** One supplier: their details, what they sell, and Archive. Editing needs the purchasing grant. */
export default function InventorySupplierRoute() {
	const { t, i18n } = useLingui()
	const ctx = usePurchasingContext()
	const { supplierId } = useParams()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const query = useInventoryQuery(
		supplierId ? `/suppliers/${encodeURIComponent(supplierId)}` : null,
		supplierDetailSchema,
	)
	const [archiveOpen, setArchiveOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const supplier = query.data

	async function archive(target: Supplier) {
		setBusy(true)
		setError(null)
		try {
			await request(`/suppliers/${encodeURIComponent(target.id)}/archive`, {
				method: 'POST',
				body: JSON.stringify({ expectedVersion: target.version }),
			})
			const name = target.name
			toast.success(t`${name} archived.`)
			notifyChanged()
			ctx.reload()
			ctx.close()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
			setArchiveOpen(false)
		} finally {
			setBusy(false)
		}
	}

	if (query.error && !query.data) {
		return (
			<SheetPanel title={<Trans>Supplier</Trans>}>
				<Alert variant="destructive" data-testid="supplier-error">
					<AlertDescription>
						{i18n._(inventoryErrorMessage(query.error))}
					</AlertDescription>
					<Button
						className="mt-2 justify-self-start"
						variant="outline"
						onClick={query.reload}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			</SheetPanel>
		)
	}

	if (!supplier) {
		return (
			<SheetPanel title={<Trans>Supplier</Trans>}>
				<div role="status" className="flex flex-col gap-2">
					<span className="sr-only">
						<Trans>Loading the supplier</Trans>
					</span>
					<Skeleton className="h-6 w-1/2" />
					<Skeleton className="h-24 w-full" />
				</div>
			</SheetPanel>
		)
	}

	const owed =
		ctx.canSeeCost &&
		supplier.unpaidMinor !== undefined &&
		supplier.unpaidCount > 0
			? formatMoney(supplier.unpaidMinor, ctx.currency, i18n.locale)
			: null

	return (
		<SheetPanel title={<span className="wrap-anywhere">{supplier.name}</span>}>
			{owed ? (
				<p className="text-sm" data-testid="supplier-owed">
					<Trans>
						You owe{' '}
						<bdi dir="ltr" className="font-medium">
							{owed}
						</bdi>
					</Trans>{' '}
					<span className="text-muted-foreground">
						<Plural
							value={supplier.unpaidCount}
							one="on # unpaid delivery."
							other="on # unpaid deliveries."
						/>
					</span>
				</p>
			) : null}

			{error ? (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			{ctx.canManagePurchasing ? (
				<SupplierForm
					key={supplier.version}
					mode="edit"
					supplier={supplier}
					currency={supplier.currency}
					layout="inline"
					onSaved={() => {
						query.reload()
						ctx.reload()
					}}
				/>
			) : (
				<SupplierSummary supplier={supplier} currency={ctx.currency} />
			)}

			<SupplierProducts
				supplierId={supplier.id}
				products={supplier.products}
				canManage={ctx.canManagePurchasing}
				canSeeCost={ctx.canSeeCost}
				currency={supplier.currency}
				locationId={ctx.activeLocationId}
				onChanged={() => {
					query.reload()
					ctx.reload()
				}}
			/>

			{ctx.canManagePurchasing ? (
				<div className="border-t pt-4">
					<Button
						type="button"
						variant="outline"
						onClick={() => setArchiveOpen(true)}
						disabled={busy}
						data-testid="supplier-archive"
					>
						<Icon name="trash-2" />
						<Trans>Archive supplier</Trans>
					</Button>
				</div>
			) : null}

			<AlertDialog
				open={archiveOpen}
				onOpenChange={(next) => {
					if (!busy) setArchiveOpen(next)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Archive this supplier?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								They no longer show when you record a delivery. Past deliveries
								stay as they are.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={busy}
							onClick={() => void archive(supplier)}
							data-testid="supplier-archive-confirm"
						>
							<Trans>Archive</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SheetPanel>
	)
}

function SupplierSummary({
	supplier,
	currency,
}: {
	supplier: Supplier
	currency: string
}) {
	const { t, i18n } = useLingui()
	const rows: Array<[string, string | null]> = [
		[t`Contact person`, supplier.contactName],
		[t`Phone`, supplier.phone],
		[t`Email`, supplier.email],
		[
			t`Delivers on`,
			supplier.deliveryDays.length > 0
				? [...supplier.deliveryDays]
						.sort((a, b) => a - b)
						.map((day) => weekdayName(day, i18n.locale))
						.join(', ')
				: null,
		],
		[
			t`Minimum order`,
			supplier.minimumOrderMinor === null ||
			supplier.minimumOrderMinor === undefined
				? null
				: formatMoney(supplier.minimumOrderMinor, currency, i18n.locale),
		],
		[t`Payment terms`, supplier.paymentTerms],
		[t`VAT number`, supplier.vatNumber],
	]
	return (
		<dl className="flex flex-col gap-2 text-sm" data-testid="supplier-summary">
			{rows
				.filter(
					(row): row is [string, string] => row[1] !== null && row[1] !== '',
				)
				.map(([label, value]) => (
					<div key={label} className="flex justify-between gap-4">
						<dt className="text-muted-foreground">{label}</dt>
						<dd className="text-end wrap-anywhere">
							<bdi dir="auto">{value}</bdi>
						</dd>
					</div>
				))}
		</dl>
	)
}
