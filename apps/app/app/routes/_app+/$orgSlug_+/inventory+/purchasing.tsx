import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	type DeliverySummary,
	deliveryDetailSchema,
	listDeliveriesResultSchema,
	listSuppliersResultSchema,
	type Supplier,
} from '@repo/inventory'
import { useDirection } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	Link,
	Outlet,
	useLocation,
	useNavigate,
	useOutlet,
	useSearchParams,
} from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { InventoryHeaderActions } from '#app/components/inventory/inventory-chrome.tsx'
import {
	useInventoryRevision,
	useNotifyInventoryChanged,
} from '#app/components/inventory/inventory-prefs.tsx'
import { type PurchasingOutletContext } from '#app/components/inventory/purchasing-context.ts'
import { weekdayName } from '#app/components/inventory/supplier-form.tsx'
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
import { localDate } from '#app/utils/inventory/today-view.ts'
import { type Route } from './+types/purchasing.ts'
import { useInventoryLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug)
	return null
}

const PAGE_SIZE = 25
const MAX_LIMIT = 200

export default function InventoryPurchasingRoute() {
	const { t, i18n } = useLingui()
	const layout = useInventoryLayoutData()
	const {
		orgSlug,
		activeLocationId,
		canEdit,
		canSeeCost,
		canManagePurchasing,
		currency,
	} = layout
	const direction = useDirection()
	const navigate = useNavigate()
	const outlet = useOutlet()
	const { search } = useLocation()
	const [searchParams, setSearchParams] = useSearchParams()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const basePath = `/${orgSlug}/inventory/purchasing`
	const unpaidOnly = searchParams.get('unpaid') === '1'
	const [limit, setLimit] = useState(PAGE_SIZE)
	const [payingId, setPayingId] = useState<string | null>(null)

	const deliveries = useInventoryQuery(
		`/deliveries?${new URLSearchParams({
			locationId: activeLocationId,
			limit: String(limit),
			...(unpaidOnly ? { unpaid: 'true' } : {}),
		})}`,
		listDeliveriesResultSchema,
	)
	const suppliers = useInventoryQuery('/suppliers', listSuppliersResultSchema)
	const { reload: reloadDeliveries } = deliveries
	const { reload: reloadSuppliers } = suppliers
	const reload = useCallback(() => {
		reloadDeliveries()
		reloadSuppliers()
	}, [reloadDeliveries, reloadSuppliers])

	const revision = useInventoryRevision()
	const seenRevision = useRef(revision)
	useEffect(() => {
		if (revision !== seenRevision.current) {
			seenRevision.current = revision
			reload()
		}
	}, [revision, reload])

	const close = useCallback(
		() => void navigate(`${basePath}${search}`),
		[navigate, basePath, search],
	)
	const outletContext: PurchasingOutletContext = {
		...layout,
		basePath,
		search,
		reload,
		close,
	}

	const money = (minor: number, code?: string) =>
		formatMoney(minor, code ?? currency, i18n.locale)
	const day = (date: string) =>
		new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(
			localDate(date),
		)

	async function markPaid(delivery: DeliverySummary) {
		setPayingId(delivery.id)
		try {
			deliveryDetailSchema.parse(
				await request(`/deliveries/${encodeURIComponent(delivery.id)}/paid`, {
					method: 'POST',
					body: JSON.stringify({
						expectedVersion: delivery.version,
						paid: true,
					}),
				}),
			)
			toast.success(t`Marked as paid.`)
			notifyChanged()
			reload()
		} catch (caught) {
			toast.error(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setPayingId(null)
		}
	}

	const rows = deliveries.data?.deliveries ?? []
	const supplierRows = suppliers.data?.suppliers ?? []
	const owedMinor = canSeeCost ? suppliers.data?.unpaidMinor : undefined
	const unpaidCount = supplierRows.reduce(
		(sum, supplier) => sum + supplier.unpaidCount,
		0,
	)
	const hasMore =
		deliveries.data?.nextCursor !== null &&
		deliveries.data?.nextCursor !== undefined
	const showTotal =
		canSeeCost && rows.some((delivery) => delivery.totalMinor !== undefined)
	const recordHref = `${basePath}/deliveries/new${search}`

	function statusBadge(delivery: DeliverySummary) {
		if (delivery.status === 'cancelled') {
			return (
				<Badge variant="outline">
					<Trans>Cancelled</Trans>
				</Badge>
			)
		}
		return delivery.paid ? null : (
			<Badge variant="warning" data-testid={`delivery-unpaid-${delivery.id}`}>
				<Trans>Unpaid</Trans>
			</Badge>
		)
	}

	function payButton(delivery: DeliverySummary) {
		return canManagePurchasing &&
			delivery.status === 'received' &&
			!delivery.paid ? (
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={payingId !== null}
				onClick={(event) => {
					event.stopPropagation()
					void markPaid(delivery)
				}}
				data-testid={`delivery-mark-paid-${delivery.id}`}
			>
				<Trans>Mark paid</Trans>
			</Button>
		) : null
	}

	return (
		<div className="flex flex-col gap-6">
			{canEdit && canSeeCost ? (
				<InventoryHeaderActions>
					<Button
						render={<Link to={recordHref} />}
						data-testid="purchasing-record-delivery"
					>
						<Icon name="plus" />
						<Trans>Record delivery</Trans>
					</Button>
				</InventoryHeaderActions>
			) : null}

			{canEdit && !canSeeCost ? (
				<Alert data-testid="purchasing-cost-note">
					<AlertDescription>
						<Trans>
							Recording a delivery needs the prices on the invoice, so it needs
							access to costs. Ask an owner to check your role.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{owedMinor !== undefined && owedMinor > 0 ? (
				<div
					className="bg-card flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"
					data-testid="purchasing-owed"
				>
					<div className="flex flex-col gap-1">
						<span className="text-muted-foreground text-sm">
							<Trans>You owe</Trans>
						</span>
						<span
							className="text-warning text-xl font-semibold tabular-nums"
							data-testid="purchasing-owed-total"
						>
							<bdi dir="ltr">{money(owedMinor, suppliers.data?.currency)}</bdi>
						</span>
						<span className="text-muted-foreground text-xs">
							<Plural
								value={unpaidCount}
								one="on # unpaid delivery"
								other="on # unpaid deliveries"
							/>
						</span>
					</div>
					<Button
						variant={unpaidOnly ? 'default' : 'outline'}
						aria-pressed={unpaidOnly}
						onClick={() => {
							const next = new URLSearchParams(searchParams)
							if (unpaidOnly) next.delete('unpaid')
							else next.set('unpaid', '1')
							setLimit(PAGE_SIZE)
							setSearchParams(next, { replace: true })
						}}
						data-testid="purchasing-unpaid-toggle"
					>
						{unpaidOnly ? (
							<Trans>Show all deliveries</Trans>
						) : (
							<Trans>Show unpaid</Trans>
						)}
					</Button>
				</div>
			) : null}

			<WorkspacePanel title={<Trans>Recent deliveries</Trans>}>
				{deliveries.error && !deliveries.data ? (
					<Alert variant="destructive" data-testid="deliveries-error">
						<AlertDescription>
							{i18n._(inventoryErrorMessage(deliveries.error))}
						</AlertDescription>
						<Button
							className="mt-2 justify-self-start"
							variant="outline"
							onClick={deliveries.reload}
						>
							<Trans>Try again</Trans>
						</Button>
					</Alert>
				) : !deliveries.data ? (
					<div role="status" className="flex flex-col gap-2">
						<span className="sr-only">
							<Trans>Loading deliveries</Trans>
						</span>
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-10 w-full" />
					</div>
				) : rows.length === 0 ? (
					unpaidOnly ? (
						<EmptyState
							title={<Trans>Nothing unpaid</Trans>}
							description={
								<Trans>Every delivery here is marked as paid.</Trans>
							}
							icons={['receipt-text', 'check-circle', 'wallet']}
						/>
					) : (
						<EmptyState
							title={<Trans>No deliveries yet</Trans>}
							description={
								<Trans>
									Record what arrives and what it cost. Stock goes up, prices
									stay current, and you see what you owe each supplier.
								</Trans>
							}
							icons={['receipt-text', 'shopping-bag', 'list']}
						>
							{canEdit && canSeeCost ? (
								<Button render={<Link to={recordHref} />}>
									<Icon name="plus" />
									<Trans>Record delivery</Trans>
								</Button>
							) : null}
						</EmptyState>
					)
				) : (
					<div
						className={
							deliveries.refreshing
								? 'opacity-70 transition-opacity'
								: undefined
						}
						aria-busy={deliveries.refreshing}
					>
						<Frame className="hidden w-full md:flex">
							<Table variant="card" data-testid="deliveries-table">
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>Date</Trans>
										</TableHead>
										<TableHead>
											<Trans>Supplier</Trans>
										</TableHead>
										<TableHead>
											<Trans>Invoice</Trans>
										</TableHead>
										{showTotal ? (
											<TableHead className="text-end">
												<Trans>Total</Trans>
											</TableHead>
										) : null}
										<TableHead>
											<span className="sr-only">
												<Trans>Status</Trans>
											</span>
										</TableHead>
										<TableHead className="w-28">
											<span className="sr-only">
												<Trans>Actions</Trans>
											</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((delivery) => (
										<TableRow
											key={delivery.id}
											className="cursor-pointer"
											data-testid={`delivery-row-${delivery.id}`}
											onClick={() =>
												void navigate(
													`${basePath}/deliveries/${delivery.id}${search}`,
												)
											}
										>
											<TableCell className="tabular-nums">
												<bdi dir="ltr">{day(delivery.businessDate)}</bdi>
											</TableCell>
											<TableCell className="wrap-anywhere">
												<Link
													to={`${basePath}/deliveries/${delivery.id}${search}`}
													className="focus-visible:ring-ring/50 rounded-sm font-medium outline-none focus-visible:ring-3"
													onClick={(event) => event.stopPropagation()}
												>
													{delivery.supplierName ?? t`No supplier`}
												</Link>
											</TableCell>
											<TableCell className="text-muted-foreground">
												{delivery.invoiceNumber ? (
													<bdi dir="ltr">{delivery.invoiceNumber}</bdi>
												) : (
													'—'
												)}
											</TableCell>
											{showTotal ? (
												<TableCell className="text-end tabular-nums">
													{delivery.totalMinor !== undefined ||
													delivery.linesTotalMinor !== undefined ? (
														<bdi dir="ltr">
															{money(
																delivery.totalMinor ??
																	delivery.linesTotalMinor ??
																	0,
																delivery.currency,
															)}
														</bdi>
													) : (
														<span className="text-muted-foreground">—</span>
													)}
												</TableCell>
											) : null}
											<TableCell>{statusBadge(delivery)}</TableCell>
											<TableCell className="text-end">
												{payButton(delivery)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</Frame>

						<ItemGroup className="md:hidden">
							{rows.map((delivery) => (
								<Item
									key={delivery.id}
									variant="outline"
									render={
										<Link
											to={`${basePath}/deliveries/${delivery.id}${search}`}
										/>
									}
									data-testid={`delivery-card-${delivery.id}`}
								>
									<ItemContent>
										<ItemTitle className="wrap-anywhere">
											{delivery.supplierName ?? t`No supplier`}
										</ItemTitle>
										<ItemDescription>
											<bdi dir="ltr">{day(delivery.businessDate)}</bdi>
											{delivery.invoiceNumber ? (
												<>
													{' · '}
													<bdi dir="ltr">{delivery.invoiceNumber}</bdi>
												</>
											) : null}
										</ItemDescription>
									</ItemContent>
									<ItemActions>
										<div className="flex flex-col items-end gap-1">
											{showTotal &&
											(delivery.totalMinor ?? delivery.linesTotalMinor) !==
												undefined ? (
												<bdi dir="ltr" className="text-sm tabular-nums">
													{money(
														(delivery.totalMinor ?? delivery.linesTotalMinor)!,
														delivery.currency,
													)}
												</bdi>
											) : null}
											{statusBadge(delivery)}
											{payButton(delivery)}
										</div>
									</ItemActions>
								</Item>
							))}
						</ItemGroup>

						{hasMore && limit < MAX_LIMIT ? (
							<div className="mt-3 flex justify-end">
								<Button
									variant="outline"
									onClick={() =>
										setLimit((current) =>
											Math.min(current + PAGE_SIZE, MAX_LIMIT),
										)
									}
									data-testid="deliveries-show-more"
								>
									<Trans>Show more</Trans>
								</Button>
							</div>
						) : null}
					</div>
				)}
			</WorkspacePanel>

			<WorkspacePanel
				title={<Trans>Suppliers</Trans>}
				action={
					canManagePurchasing ? (
						<Button
							variant="outline"
							size="sm"
							render={<Link to={`${basePath}/suppliers/new${search}`} />}
							data-testid="suppliers-add"
						>
							<Icon name="plus" />
							<Trans>Add supplier</Trans>
						</Button>
					) : undefined
				}
			>
				{suppliers.error && !suppliers.data ? (
					<Alert variant="destructive" data-testid="suppliers-error">
						<AlertDescription>
							{i18n._(inventoryErrorMessage(suppliers.error))}
						</AlertDescription>
						<Button
							className="mt-2 justify-self-start"
							variant="outline"
							onClick={suppliers.reload}
						>
							<Trans>Try again</Trans>
						</Button>
					</Alert>
				) : !suppliers.data ? (
					<Skeleton className="h-10 w-full" />
				) : supplierRows.length === 0 ? (
					<EmptyState
						title={<Trans>No suppliers yet</Trans>}
						description={
							<Trans>
								Add who you buy from, with how they take orders and when they
								deliver. A delivery can then fill in their prices.
							</Trans>
						}
						icons={['shopping-bag', 'phone', 'list']}
					>
						{canManagePurchasing ? (
							<Button
								render={<Link to={`${basePath}/suppliers/new${search}`} />}
							>
								<Icon name="plus" />
								<Trans>Add supplier</Trans>
							</Button>
						) : null}
					</EmptyState>
				) : (
					<ul
						className="flex flex-col divide-y rounded-xl border"
						data-testid="suppliers-list"
					>
						{supplierRows.map((supplier) => (
							<SupplierRow
								key={supplier.id}
								supplier={supplier}
								href={`${basePath}/suppliers/${supplier.id}${search}`}
								showMoney={canSeeCost}
								money={money}
								locale={i18n.locale}
							/>
						))}
					</ul>
				)}
			</WorkspacePanel>

			<Sheet
				open={outlet !== null}
				onOpenChange={(open) => {
					if (!open) close()
				}}
			>
				<SheetContent
					side={direction === 'rtl' ? 'left' : 'right'}
					className="flex w-full flex-col gap-0 data-[side=left]:sm:max-w-xl data-[side=right]:sm:max-w-xl"
				>
					<Outlet context={outletContext} />
				</SheetContent>
			</Sheet>
		</div>
	)
}

function SupplierRow({
	supplier,
	href,
	showMoney,
	money,
	locale,
}: {
	supplier: Supplier
	href: string
	showMoney: boolean
	money: (minor: number, code?: string) => string
	locale: string
}) {
	const days = [...supplier.deliveryDays]
		.sort((a, b) => a - b)
		.map((day) => weekdayName(day, locale))
		.join(', ')
	return (
		<li data-testid={`supplier-row-${supplier.id}`}>
			<Link
				to={href}
				className="hover:bg-muted/50 focus-visible:ring-ring/50 flex min-h-14 items-center justify-between gap-3 p-3 outline-none focus-visible:ring-3"
			>
				<span className="flex min-w-0 flex-col">
					<span className="font-medium wrap-anywhere">{supplier.name}</span>
					<span className="text-muted-foreground text-xs">
						{[supplier.contactName, days].filter(Boolean).join(' · ')}
					</span>
				</span>
				<span className="flex shrink-0 flex-col items-end gap-1">
					{supplier.unpaidCount > 0 ? (
						<Badge variant="warning">
							{showMoney && supplier.unpaidMinor !== undefined ? (
								<bdi dir="ltr">{money(supplier.unpaidMinor)}</bdi>
							) : (
								<Trans>Unpaid</Trans>
							)}
						</Badge>
					) : null}
				</span>
			</Link>
		</li>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
