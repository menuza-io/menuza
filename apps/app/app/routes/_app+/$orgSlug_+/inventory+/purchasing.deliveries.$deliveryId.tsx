import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { type DeliveryDetail, deliveryDetailSchema } from '@repo/inventory'
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
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import { useParams } from 'react-router'
import { toast } from 'sonner'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { usePurchasingContext } from '#app/components/inventory/purchasing-context.ts'
import { useItemBaseUnits } from '#app/components/inventory/use-item-base-units.ts'
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
import { type Route } from './+types/purchasing.deliveries.$deliveryId.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug)
	return null
}

/**
 * One delivery as it was recorded: lines, the invoice and VAT, paid or not.
 * Mark paid needs the purchasing grant; cancelling (which takes the stock
 * back out) needs the inventory grant.
 */
export default function InventoryDeliveryRoute() {
	const { t, i18n } = useLingui()
	const ctx = usePurchasingContext()
	const { deliveryId } = useParams()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const query = useInventoryQuery(
		deliveryId ? `/deliveries/${encodeURIComponent(deliveryId)}` : null,
		deliveryDetailSchema,
	)
	const delivery = query.data
	const baseUnits = useItemBaseUnits(
		delivery?.lines.map((line) => line.itemId) ?? [],
		delivery?.locationId ?? ctx.activeLocationId,
	)
	const [cancelOpen, setCancelOpen] = useState(false)
	const [note, setNote] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function post(
		action: 'paid' | 'cancel',
		target: DeliveryDetail,
		body: Record<string, unknown>,
		done: string,
	) {
		setBusy(true)
		setError(null)
		try {
			deliveryDetailSchema.parse(
				await request(
					`/deliveries/${encodeURIComponent(target.id)}/${action}`,
					{
						method: 'POST',
						body: JSON.stringify({ expectedVersion: target.version, ...body }),
					},
				),
			)
			toast.success(done)
			notifyChanged()
			ctx.reload()
			query.reload()
			setCancelOpen(false)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
			setCancelOpen(false)
			query.reload()
		} finally {
			setBusy(false)
		}
	}

	if (query.error && !query.data) {
		return (
			<SheetPanel title={<Trans>Delivery</Trans>}>
				<Alert variant="destructive" data-testid="delivery-error">
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

	if (!delivery) {
		return (
			<SheetPanel title={<Trans>Delivery</Trans>}>
				<div role="status" className="flex flex-col gap-2">
					<span className="sr-only">
						<Trans>Loading the delivery</Trans>
					</span>
					<Skeleton className="h-6 w-1/2" />
					<Skeleton className="h-24 w-full" />
				</div>
			</SheetPanel>
		)
	}

	const code = delivery.currency ?? ctx.currency
	const money = (minor: number) => formatMoney(minor, code, i18n.locale)
	const when = delivery.receivedAt
		? new Intl.DateTimeFormat(i18n.locale, {
				dateStyle: 'medium',
				timeStyle: 'short',
			}).format(new Date(delivery.receivedAt))
		: delivery.businessDate
	const showMoney = ctx.canSeeCost && delivery.totalMinor !== undefined
	const cancelled = delivery.status === 'cancelled'
	const supplierName = delivery.supplierName ?? t`No supplier`
	const lineText = (line: DeliveryDetail['lines'][number]) => {
		const baseUnit = baseUnits[line.itemId]
		const amount = baseUnit
			? quantity.format(line.realWeightQuantity ?? line.quantity, { baseUnit })
			: null
		if (line.packs !== null && line.packName) {
			const packs = new Intl.NumberFormat(i18n.locale, {
				maximumFractionDigits: 3,
			}).format(line.packs)
			return `${packs} × ${line.packName}${amount ? ` · ${amount}` : ''}`
		}
		return amount ?? ''
	}

	return (
		<SheetPanel
			title={<span className="wrap-anywhere">{supplierName}</span>}
			description={<bdi dir="auto">{when}</bdi>}
			headerExtra={
				<div className="flex flex-wrap items-center gap-1">
					{cancelled ? (
						<Badge variant="outline">
							<Trans>Cancelled</Trans>
						</Badge>
					) : delivery.paid ? (
						<Badge variant="success">
							<Trans>Paid</Trans>
						</Badge>
					) : (
						<Badge variant="warning" data-testid="delivery-unpaid">
							<Trans>Unpaid</Trans>
						</Badge>
					)}
				</div>
			}
		>
			{error ? (
				<Alert variant="destructive" data-testid="delivery-save-error">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			{cancelled ? (
				<Alert data-testid="delivery-cancelled">
					<AlertDescription>
						<Trans>
							This delivery was cancelled. Its stock was taken back out.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			<dl className="flex flex-col gap-2 text-sm">
				{delivery.invoiceNumber ? (
					<div className="flex justify-between gap-4">
						<dt className="text-muted-foreground">
							<Trans>Invoice number</Trans>
						</dt>
						<dd className="text-end">
							<bdi dir="ltr">{delivery.invoiceNumber}</bdi>
						</dd>
					</div>
				) : null}
				{delivery.invoiceDate ? (
					<div className="flex justify-between gap-4">
						<dt className="text-muted-foreground">
							<Trans>Invoice date</Trans>
						</dt>
						<dd className="text-end">
							<bdi dir="ltr">{delivery.invoiceDate}</bdi>
						</dd>
					</div>
				) : null}
				{delivery.zatcaReference ? (
					<div className="flex justify-between gap-4">
						<dt className="text-muted-foreground">
							<Trans>ZATCA invoice reference</Trans>
						</dt>
						<dd className="text-end wrap-anywhere">
							<bdi dir="ltr">{delivery.zatcaReference}</bdi>
						</dd>
					</div>
				) : null}
			</dl>

			<section className="flex flex-col gap-2" aria-label={t`Lines`}>
				<h3 className="text-sm font-semibold">
					<Plural value={delivery.lineCount} one="# line" other="# lines" />
				</h3>
				<ul
					className="flex flex-col divide-y rounded-xl border"
					data-testid="delivery-lines"
				>
					{delivery.lines.map((line) => (
						<li key={line.id} className="flex flex-col gap-1 p-3">
							<div className="flex items-start justify-between gap-3">
								<span className="font-medium wrap-anywhere">
									{line.itemName}
								</span>
								{showMoney && line.lineTotalMinor !== undefined ? (
									<bdi dir="ltr" className="text-sm tabular-nums">
										{money(line.lineTotalMinor)}
									</bdi>
								) : null}
							</div>
							<span className="text-muted-foreground text-xs">
								<bdi dir="auto">{lineText(line)}</bdi>
								{showMoney &&
								line.priceChangeBp !== null &&
								line.priceChangeBp !== undefined &&
								line.priceChangeBp !== 0 ? (
									<>
										{' · '}
										<span
											className={
												line.priceChangeBp > 0 ? 'text-warning' : 'text-success'
											}
											data-testid={`delivery-line-change-${line.id}`}
										>
											<bdi dir="ltr">
												{new Intl.NumberFormat(i18n.locale, {
													style: 'percent',
													maximumFractionDigits: 1,
													signDisplay: 'exceptZero',
												}).format(line.priceChangeBp / 10_000)}
											</bdi>
										</span>
									</>
								) : null}
							</span>
						</li>
					))}
				</ul>
			</section>

			{showMoney ? (
				<dl
					className="flex flex-col gap-1 text-sm"
					data-testid="delivery-totals"
				>
					{delivery.linesTotalMinor !== undefined ? (
						<div className="flex justify-between gap-4">
							<dt className="text-muted-foreground">
								<Trans>Lines</Trans>
							</dt>
							<dd className="tabular-nums">
								<bdi dir="ltr">{money(delivery.linesTotalMinor)}</bdi>
							</dd>
						</div>
					) : null}
					{delivery.vatMinor !== undefined && delivery.vatMinor !== null ? (
						<div className="flex justify-between gap-4">
							<dt className="text-muted-foreground">
								<Trans>VAT</Trans>
							</dt>
							<dd className="tabular-nums">
								<bdi dir="ltr">{money(delivery.vatMinor)}</bdi>
							</dd>
						</div>
					) : null}
					{delivery.totalMinor !== undefined && delivery.totalMinor !== null ? (
						<div className="flex justify-between gap-4 font-medium">
							<dt>
								<Trans>Invoice total</Trans>
							</dt>
							<dd className="tabular-nums">
								<bdi dir="ltr">{money(delivery.totalMinor)}</bdi>
							</dd>
						</div>
					) : null}
				</dl>
			) : null}

			{!cancelled ? (
				<div className="flex flex-wrap gap-2 border-t pt-4">
					{ctx.canManagePurchasing ? (
						<Button
							type="button"
							variant={delivery.paid ? 'outline' : 'default'}
							disabled={busy}
							onClick={() =>
								void post(
									'paid',
									delivery,
									{ paid: !delivery.paid },
									delivery.paid ? t`Marked as unpaid.` : t`Marked as paid.`,
								)
							}
							data-testid="delivery-toggle-paid"
						>
							{delivery.paid ? (
								<Trans>Mark unpaid</Trans>
							) : (
								<Trans>Mark paid</Trans>
							)}
						</Button>
					) : null}
					{ctx.canEdit ? (
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={() => setCancelOpen(true)}
							data-testid="delivery-cancel"
						>
							<Trans>Cancel delivery</Trans>
						</Button>
					) : null}
				</div>
			) : null}

			<AlertDialog
				open={cancelOpen}
				onOpenChange={(next) => {
					if (!busy) setCancelOpen(next)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Cancel this delivery?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								The stock it added is taken back out. Use this when a delivery
								was entered by mistake.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<Textarea
						value={note}
						onChange={(event) =>
							setNote(event.target.value.replace(/[\r\n]+/g, ' '))
						}
						rows={2}
						maxLength={500}
						placeholder={t`Why? (optional)`}
						aria-label={t`Why is it cancelled?`}
						data-testid="delivery-cancel-note"
					/>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>
							<Trans>Keep the delivery</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={busy}
							onClick={() =>
								void post(
									'cancel',
									delivery,
									note.trim() === '' ? {} : { note: note.trim() },
									t`Delivery cancelled.`,
								)
							}
							data-testid="delivery-cancel-confirm"
						>
							<Trans>Cancel delivery</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SheetPanel>
	)
}
