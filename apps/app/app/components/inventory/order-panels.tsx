import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	type InventoryBaseUnit,
	type listOrdersResultSchema,
	milliToPacks,
	orderDetailSchema,
	type OrderLineExplanation,
	type OrderSummary,
	type SuggestedOrders,
	type SuggestedSupplierOrder,
	type Supplier,
	type UnitRef,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import {
	Popover,
	PopoverContent,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from '@repo/ui/popover'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { type z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useQuantityFormat } from '#app/components/inventory/inventory-prefs.tsx'
import { SelectField } from '#app/components/staff/controls.tsx'
import {
	useInventoryClient,
	type InventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import {
	inventoryOrderPath,
	inventoryReceivePath,
} from '#app/utils/inventory/nav.ts'
import {
	cutoffText,
	ORDER_STATUS_LABELS,
	orderStatusVariant,
	packsText,
	shortDayText,
	weekdayShort,
} from '#app/utils/inventory/order-view.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'

export type ListOrdersResult = z.infer<typeof listOrdersResultSchema>

/** Creates a draft (from the suggestion, or blank) and opens it for review. */
export function useCreateDraft({
	orgSlug,
	locationId,
	search,
	onCreated,
}: {
	orgSlug: string
	locationId: string
	search: string
	onCreated?: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const navigate = useNavigate()
	const [pending, setPending] = useState<string | null>(null)
	// One client id per supplier until it succeeds, so a retry (or a second
	// click) never makes a second draft.
	const clientIds = useRef(new Map<string, string>())

	async function create(supplierId: string, fromSuggestion: boolean) {
		if (pending !== null) return
		setPending(supplierId)
		const key = `${supplierId}:${fromSuggestion}`
		const clientId = clientIds.current.get(key) ?? newClientId('o')
		clientIds.current.set(key, clientId)
		try {
			const order = orderDetailSchema.parse(
				await request('/orders', {
					method: 'POST',
					body: JSON.stringify({
						clientId,
						locationId,
						supplierId,
						...(fromSuggestion ? { fromSuggestion: true } : {}),
					}),
				}),
			)
			clientIds.current.delete(key)
			onCreated?.()
			void navigate(`${inventoryOrderPath(orgSlug, order.id)}${search}`)
		} catch (caught) {
			toast.error(i18n._(inventorySaveErrorMessage(caught)), {
				description: t`Nothing was sent. You can try again.`,
			})
		} finally {
			setPending(null)
		}
	}
	return { create, pending }
}

export function OrderLineWarnings({
	lineKey,
	explanation,
	canSeeCost,
}: {
	lineKey: string
	explanation: OrderLineExplanation
	canSeeCost: boolean
}) {
	const { warnings } = explanation
	const showPrice = canSeeCost && warnings.priceChangedSinceLastOrder
	const showMin = canSeeCost && warnings.belowSupplierMinimum
	if (!warnings.notCountedIn10Days && !showPrice && !showMin) return null
	return (
		<div className="flex flex-wrap gap-1.5">
			{warnings.notCountedIn10Days ? (
				<Badge
					variant="warning"
					data-testid={`order-line-warn-stale-${lineKey}`}
				>
					<Trans>Not counted in 10 days</Trans>
				</Badge>
			) : null}
			{showPrice ? (
				<Badge
					variant="warning"
					data-testid={`order-line-warn-price-${lineKey}`}
				>
					<Trans>Price changed since the last order</Trans>
				</Badge>
			) : null}
			{showMin ? (
				<Badge variant="warning" data-testid={`order-line-warn-min-${lineKey}`}>
					<Trans>Below the supplier's minimum</Trans>
				</Badge>
			) : null}
		</div>
	)
}

export function OrderLineExplanationPopover({
	lineKey,
	itemName,
	baseUnit,
	countUnit,
	explanation,
	canSeeCost,
	money,
}: {
	lineKey: string
	itemName: string
	baseUnit: InventoryBaseUnit
	countUnit: UnitRef | null
	explanation: OrderLineExplanation
	canSeeCost: boolean
	money?: ((minor: number) => string) | null
}) {
	const { t, i18n } = useLingui()
	const quantity = useQuantityFormat()
	const unitOpts = { baseUnit, countUnit }
	const onHandText = quantity.format(explanation.onHandQuantity, unitOpts)
	const onOrderText = quantity.format(explanation.onOrderQuantity, unitOpts)
	const lastCountedLabel =
		explanation.lastCountedAt !== null
			? new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(
					new Date(explanation.lastCountedAt),
				)
			: null
	const orderBelowText =
		explanation.orderBelowQuantity !== null
			? quantity.format(explanation.orderBelowQuantity, unitOpts)
			: null
	const fillUpToText =
		explanation.fillUpToQuantity !== null
			? quantity.format(explanation.fillUpToQuantity, unitOpts)
			: null
	const expectedUseText =
		explanation.expectedUseUntilDeliveryQuantity !== null
			? quantity.format(explanation.expectedUseUntilDeliveryQuantity, unitOpts)
			: null
	const cateringText =
		explanation.cateringQuantity && explanation.cateringQuantity > 0
			? quantity.format(explanation.cateringQuantity, unitOpts)
			: null
	const packSizeText = quantity.format(explanation.packBaseQuantity, {
		baseUnit,
	})
	const neededText = quantity.format(explanation.neededQuantity, unitOpts)
	const rawPacks = milliToPacks(explanation.rawPacksMilli)
	const roundedPacks = milliToPacks(explanation.roundedPacksMilli)
	const rawPacksLabel = packsText(rawPacks, i18n.locale)
	const roundedPacksLabel = packsText(roundedPacks, i18n.locale)
	const packName = explanation.packName
	const prevPrice =
		canSeeCost &&
		money &&
		explanation.warnings.priceChangedSinceLastOrder &&
		explanation.previousOrderPackPriceMinor != null &&
		explanation.currentPackPriceMinor != null
			? money(explanation.previousOrderPackPriceMinor)
			: null
	const currPrice =
		prevPrice !== null && money && explanation.currentPackPriceMinor != null
			? money(explanation.currentPackPriceMinor)
			: null

	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={t`Why ${itemName} is suggested`}
						data-testid={`order-line-info-${lineKey}`}
					>
						<Icon name="info" />
					</Button>
				}
			/>
			<PopoverContent
				align="end"
				className="w-80"
				data-testid={`order-line-explanation-${lineKey}`}
			>
				<PopoverHeader>
					<PopoverTitle className="wrap-anywhere">{itemName}</PopoverTitle>
				</PopoverHeader>
				<dl className="flex flex-col gap-1.5 text-xs">
					<div className="flex justify-between gap-3">
						<dt className="text-muted-foreground">
							<Trans>On hand</Trans>
						</dt>
						<dd className="text-end">
							<bdi dir="ltr" className="tabular-nums">
								{onHandText}
							</bdi>
							<span className="text-muted-foreground block">
								{lastCountedLabel ? (
									<Trans>
										Counted <bdi dir="ltr">{lastCountedLabel}</bdi>
									</Trans>
								) : (
									<Trans>Never counted</Trans>
								)}
							</span>
						</dd>
					</div>
					<div className="flex justify-between gap-3">
						<dt className="text-muted-foreground">
							<Trans>Already on order</Trans>
						</dt>
						<dd>
							<bdi dir="ltr" className="tabular-nums">
								{onOrderText}
							</bdi>
						</dd>
					</div>
					{orderBelowText !== null ? (
						<div className="flex justify-between gap-3">
							<dt className="text-muted-foreground">
								<Trans>Order below</Trans>
							</dt>
							<dd>
								<bdi dir="ltr" className="tabular-nums">
									{orderBelowText}
								</bdi>
							</dd>
						</div>
					) : null}
					{fillUpToText !== null ? (
						<div className="flex justify-between gap-3">
							<dt className="text-muted-foreground">
								<Trans>Fill up to</Trans>
							</dt>
							<dd>
								<bdi dir="ltr" className="tabular-nums">
									{fillUpToText}
								</bdi>
							</dd>
						</div>
					) : null}
					<div className="flex justify-between gap-3">
						<dt className="text-muted-foreground">
							<Trans>Use until next delivery</Trans>
						</dt>
						<dd>
							{expectedUseText !== null ? (
								<bdi dir="ltr" className="tabular-nums">
									{expectedUseText}
								</bdi>
							) : (
								<span className="text-muted-foreground">
									<Trans>Not enough history</Trans>
								</span>
							)}
						</dd>
					</div>
					{cateringText ? (
						<div className="flex justify-between gap-3">
							<dt className="text-muted-foreground">
								<Trans>Needed for catering orders</Trans>
							</dt>
							<dd>
								<bdi dir="ltr" className="tabular-nums">
									{cateringText}
								</bdi>
							</dd>
						</div>
					) : null}
					<div className="flex justify-between gap-3 border-t pt-1.5">
						<dt className="text-muted-foreground">
							<Trans>Pack size</Trans>
						</dt>
						<dd className="text-end wrap-anywhere">
							{packName}
							{' · '}
							<bdi dir="ltr" className="tabular-nums">
								{packSizeText}
							</bdi>
						</dd>
					</div>
					<div className="flex justify-between gap-3">
						<dt className="text-muted-foreground">
							<Trans>Rounding</Trans>
						</dt>
						<dd className="text-end">
							<Trans>
								Needed <bdi dir="ltr">{neededText}</bdi> (
								<bdi dir="ltr">{rawPacksLabel}</bdi>) →{' '}
								<bdi dir="ltr">{roundedPacksLabel}</bdi> packs
							</Trans>
						</dd>
					</div>
					{prevPrice && currPrice ? (
						<div className="flex justify-between gap-3 border-t pt-1.5">
							<dt className="text-muted-foreground">
								<Trans>Pack price</Trans>
							</dt>
							<dd className="text-end tabular-nums">
								<Trans>
									Last order <bdi dir="ltr">{prevPrice}</bdi> → now{' '}
									<bdi dir="ltr">{currPrice}</bdi>
								</Trans>
							</dd>
						</div>
					) : null}
				</dl>
			</PopoverContent>
		</Popover>
	)
}

function SuggestedCard({
	card,
	canSeeCost,
	canManage,
	currency,
	pending,
	onReview,
	continueHref,
}: {
	card: SuggestedSupplierOrder
	canSeeCost: boolean
	canManage: boolean
	currency: string
	pending: boolean
	onReview: () => void
	continueHref: string | null
}) {
	const { i18n } = useLingui()
	const lineCount = card.lineCount
	const supplier = card.supplierName
	const total =
		canSeeCost && card.totalMinor !== undefined
			? formatMoney(card.totalMinor, card.currency ?? currency, i18n.locale)
			: null
	const cardMoney = canSeeCost
		? (minor: number) =>
				formatMoney(minor, card.currency ?? currency, i18n.locale)
		: null
	const minimum =
		canSeeCost && card.belowMinimum && card.minimumOrderMinor !== undefined
			? formatMoney(
					card.minimumOrderMinor,
					card.currency ?? currency,
					i18n.locale,
				)
			: null
	const unpriced = card.unpricedLines ?? 0
	const expected = card.expectedDate
		? weekdayShort(card.expectedDate, i18n.locale)
		: null
	const by = card.cutoff ? cutoffText(card.cutoff, i18n.locale) : null

	return (
		<li
			className="bg-card flex flex-col gap-3 rounded-xl border p-4"
			data-testid={`suggested-${card.supplierId}`}
		>
			<div className="flex flex-col gap-1">
				<span className="font-medium wrap-anywhere">{supplier}</span>
				<span className="text-muted-foreground text-sm">
					<Plural value={lineCount} one="# item" other="# items" />
					{total ? (
						<>
							{' · '}
							<bdi dir="ltr" className="tabular-nums">
								{total}
							</bdi>
						</>
					) : null}
				</span>
			</div>
			<div className="flex flex-col gap-1 text-sm">
				{card.cutoffPassed ? (
					<span className="text-warning" data-testid="suggested-passed">
						{expected ? (
							<Trans>
								The cut-off for <bdi dir="ltr">{expected}</bdi> has passed.
							</Trans>
						) : (
							<Trans>The cut-off has passed.</Trans>
						)}
					</span>
				) : by && expected ? (
					<span data-testid="suggested-cutoff">
						<Trans>
							Order by <bdi dir="ltr">{by}</bdi> for{' '}
							<bdi dir="ltr">{expected}</bdi>
						</Trans>
					</span>
				) : expected ? (
					<span>
						<Trans>
							For <bdi dir="ltr">{expected}</bdi>
						</Trans>
					</span>
				) : null}
				{minimum ? (
					<span className="text-warning" data-testid="suggested-minimum">
						<Trans>
							Below the minimum order of <bdi dir="ltr">{minimum}</bdi>
						</Trans>
					</span>
				) : null}
				{unpriced > 0 && canSeeCost ? (
					<span className="text-muted-foreground">
						<Plural
							value={unpriced}
							one="# item has no price yet"
							other="# items have no price yet"
						/>
					</span>
				) : null}
			</div>
			{card.lines.length > 0 ? (
				<ul
					className="flex flex-col gap-2 border-t pt-2 text-xs"
					data-testid={`suggested-lines-${card.supplierId}`}
				>
					{card.lines.map((line) => (
						<li key={line.itemId} className="flex flex-col gap-1">
							<div className="flex items-center justify-between gap-2">
								<span className="min-w-0 truncate font-medium wrap-anywhere">
									{line.itemName}
								</span>
								<div className="flex shrink-0 items-center gap-1">
									<span className="text-muted-foreground tabular-nums">
										<bdi dir="ltr">{packsText(line.packs, i18n.locale)}</bdi>
										{' × '}
										<span className="wrap-anywhere">{line.packName}</span>
									</span>
									{line.explanation ? (
										<OrderLineExplanationPopover
											lineKey={line.itemId}
											itemName={line.itemName}
											baseUnit={line.baseUnit}
											countUnit={line.countUnit}
											explanation={line.explanation}
											canSeeCost={canSeeCost}
											money={cardMoney}
										/>
									) : null}
								</div>
							</div>
							{line.explanation ? (
								<OrderLineWarnings
									lineKey={line.itemId}
									explanation={line.explanation}
									canSeeCost={canSeeCost}
								/>
							) : null}
						</li>
					))}
				</ul>
			) : null}
			{canManage ? (
				<div className="mt-auto flex justify-end">
					{continueHref ? (
						<Button
							variant="outline"
							render={<Link to={continueHref} />}
							data-testid={`suggested-continue-${card.supplierId}`}
						>
							<Trans>Continue draft</Trans>
						</Button>
					) : (
						<Button
							onClick={onReview}
							disabled={pending}
							data-testid={`suggested-review-${card.supplierId}`}
						>
							{pending ? <Icon name="loader" className="animate-spin" /> : null}
							<Trans>Review order</Trans>
						</Button>
					)}
				</div>
			) : null}
		</li>
	)
}

/** "Suggested orders": one card per supplier with what is below its level. Nothing is sent from here. */
export function SuggestedOrdersPanel({
	query,
	orgSlug,
	locationId,
	search,
	canSeeCost,
	canManagePurchasing,
	currency,
	suppliersHref,
	onChanged,
}: {
	query: InventoryQuery<SuggestedOrders>
	orgSlug: string
	locationId: string
	search: string
	canSeeCost: boolean
	canManagePurchasing: boolean
	currency: string
	suppliersHref: string
	onChanged: () => void
}) {
	const { i18n } = useLingui()
	const drafts = useCreateDraft({
		orgSlug,
		locationId,
		search,
		onCreated: onChanged,
	})
	const data = query.data
	return (
		<WorkspacePanel title={<Trans>Suggested orders</Trans>}>
			{query.error && !data ? (
				<Alert variant="destructive" data-testid="suggested-error">
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
			) : !data ? (
				<div role="status" className="flex flex-col gap-2">
					<span className="sr-only">
						<Trans>Loading suggested orders</Trans>
					</span>
					<Skeleton className="h-24 w-full" />
				</div>
			) : data.suppliers.length === 0 &&
			  data.unsourced.length === 0 &&
			  (!data.overdueOrderWarnings ||
					data.overdueOrderWarnings.length === 0) ? (
				<EmptyState
					title={<Trans>Nothing to order right now</Trans>}
					description={
						<Trans>
							When an item drops below the amount you order at, it shows here
							with what to order from each supplier. Set those amounts under
							Stock, Set levels.
						</Trans>
					}
					icons={['shopping-bag', 'check-circle', 'list']}
				/>
			) : (
				<div
					className={
						query.refreshing
							? 'flex flex-col gap-3 opacity-70 transition-opacity'
							: 'flex flex-col gap-3'
					}
					aria-busy={query.refreshing}
				>
					{data.overdueOrderWarnings && data.overdueOrderWarnings.length > 0 ? (
						<Alert data-testid="suggested-overdue-warnings">
							<Icon name="alert-triangle" />
							<AlertDescription>
								<div className="flex flex-col gap-1">
									<span className="font-medium">
										<Trans>Overdue orders no longer count as on order</Trans>
									</span>
									<ul className="flex flex-col gap-1 text-xs">
										{data.overdueOrderWarnings.map((warning) => {
											const orderNum = warning.number
											const days = warning.daysOverdue
											const supplier = warning.supplierName
											return (
												<li key={warning.orderId}>
													<Link
														to={`${inventoryOrderPath(orgSlug, warning.orderId)}${search}`}
														className="wrap-anywhere underline"
														data-testid={`suggested-overdue-${warning.orderId}`}
													>
														<Trans>
															Order {orderNum} from {supplier} (
															<bdi dir="ltr">
																<Plural
																	value={days}
																	one="# day late"
																	other="# days late"
																/>
															</bdi>
															)
														</Trans>
													</Link>
												</li>
											)
										})}
									</ul>
								</div>
							</AlertDescription>
						</Alert>
					) : null}
					{data.suppliers.length === 0 && data.unsourced.length === 0 ? (
						<EmptyState
							title={<Trans>Nothing to order right now</Trans>}
							description={
								<Trans>
									When an item drops below the amount you order at, it shows
									here with what to order from each supplier. Set those amounts
									under Stock, Set levels.
								</Trans>
							}
							icons={['shopping-bag', 'check-circle', 'list']}
						/>
					) : null}
					{data.suppliers.length > 0 ? (
						<ul
							className="grid gap-3 sm:grid-cols-2"
							data-testid="suggested-orders"
						>
							{data.suppliers.map((card) => (
								<SuggestedCard
									key={card.supplierId}
									card={card}
									canSeeCost={canSeeCost}
									canManage={canManagePurchasing}
									currency={currency}
									pending={drafts.pending === card.supplierId}
									onReview={() => void drafts.create(card.supplierId, true)}
									continueHref={
										card.draftOrderId
											? `${inventoryOrderPath(orgSlug, card.draftOrderId)}${search}`
											: null
									}
								/>
							))}
						</ul>
					) : null}
					{data.unsourced.length > 0 ? (
						<Alert data-testid="suggested-unsourced">
							<AlertDescription>
								<Plural
									value={data.unsourced.length}
									one="# item is low but has no supplier yet:"
									other="# items are low but have no supplier yet:"
								/>{' '}
								<span className="wrap-anywhere">
									{data.unsourced
										.slice(0, 5)
										.map((item) => item.itemName)
										.join(', ')}
									{data.unsourced.length > 5 ? '…' : ''}
								</span>{' '}
								{canManagePurchasing ? (
									<Link to={suppliersHref} className="underline">
										<Trans>Add a supplier</Trans>
									</Link>
								) : null}
							</AlertDescription>
						</Alert>
					) : null}
				</div>
			)}
		</WorkspacePanel>
	)
}

function OrderRow({
	order,
	orgSlug,
	search,
	canSeeCost,
	canReceive,
	currency,
}: {
	order: OrderSummary
	orgSlug: string
	search: string
	canSeeCost: boolean
	canReceive: boolean
	currency: string
}) {
	const { i18n } = useLingui()
	const supplier = order.supplierName
	const number = order.number
	const sent = order.sentAt
		? new Intl.DateTimeFormat(i18n.locale, { weekday: 'short' }).format(
				new Date(order.sentAt),
			)
		: null
	const due = order.expectedDate
		? shortDayText(order.expectedDate, i18n.locale)
		: null
	const total =
		canSeeCost && order.totalMinor !== undefined
			? formatMoney(order.totalMinor, order.currency ?? currency, i18n.locale)
			: null
	return (
		<li
			className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
			data-testid={`order-row-${order.id}`}
		>
			<Link
				to={`${inventoryOrderPath(orgSlug, order.id)}${search}`}
				className="focus-visible:ring-ring/50 flex min-w-0 flex-col rounded-sm outline-none focus-visible:ring-3"
			>
				<span className="flex flex-wrap items-center gap-2">
					<span className="font-medium wrap-anywhere">{supplier}</span>
					<Badge
						variant={orderStatusVariant(order.status)}
						data-testid={`order-status-${order.id}`}
					>
						{i18n._(ORDER_STATUS_LABELS[order.status])}
					</Badge>
				</span>
				<span className="text-muted-foreground text-xs">
					<Trans>Order {number}</Trans>
					{sent ? (
						<>
							{' · '}
							<Trans>
								sent <bdi dir="ltr">{sent}</bdi>
							</Trans>
						</>
					) : null}
					{due ? (
						<>
							{' · '}
							<Trans>
								due <bdi dir="ltr">{due}</bdi>
							</Trans>
						</>
					) : null}
					{total ? (
						<>
							{' · '}
							<bdi dir="ltr" className="tabular-nums">
								{total}
							</bdi>
						</>
					) : null}
				</span>
			</Link>
			{canReceive && order.status !== 'waiting_for_approval' ? (
				<Button
					variant="outline"
					size="sm"
					className="self-start sm:self-auto"
					render={
						<Link
							to={`${inventoryReceivePath(orgSlug, order.id)}${search.replace('?', '&')}`}
						/>
					}
					data-testid={`order-receive-${order.id}`}
				>
					<Trans>Receive</Trans>
				</Button>
			) : null}
		</li>
	)
}

/** Orders that are drafted, sent or partly received, newest first, each with Receive. */
export function OpenOrdersPanel({
	query,
	orgSlug,
	search,
	canSeeCost,
	canEdit,
	currency,
}: {
	query: InventoryQuery<ListOrdersResult>
	orgSlug: string
	search: string
	canSeeCost: boolean
	canEdit: boolean
	currency: string
}) {
	const { i18n } = useLingui()
	const rows = query.data?.orders ?? []
	return (
		<WorkspacePanel title={<Trans>Open orders</Trans>}>
			{query.error && !query.data ? (
				<Alert variant="destructive" data-testid="orders-error">
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
			) : !query.data ? (
				<Skeleton className="h-10 w-full" />
			) : rows.length === 0 ? (
				<p className="text-muted-foreground text-sm" data-testid="orders-empty">
					<Trans>No open orders. Orders you start or send show here.</Trans>
				</p>
			) : (
				<ul
					className="flex flex-col divide-y rounded-xl border"
					data-testid="open-orders"
				>
					{rows.map((order) => (
						<OrderRow
							key={order.id}
							order={order}
							orgSlug={orgSlug}
							search={search}
							canSeeCost={canSeeCost}
							canReceive={canEdit}
							currency={currency}
						/>
					))}
				</ul>
			)}
		</WorkspacePanel>
	)
}

/** "New order": pick a supplier and start an empty draft to fill on the review page. */
export function NewOrderDialog({
	open,
	onOpenChange,
	suppliers,
	pending,
	onCreate,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	suppliers: readonly Supplier[]
	pending: boolean
	onCreate: (supplierId: string) => void
}) {
	const { t } = useLingui()
	const [supplierId, setSupplierId] = useState('')
	const choices = suppliers.filter((supplier) => !supplier.archived)
	return (
		<Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
			<DialogContent className="sm:max-w-md" data-testid="new-order-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>New order</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Who do you want to order from? You add the items on the next page,
							and nothing is sent until you review it.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{choices.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>Add a supplier first.</Trans>
					</p>
				) : (
					<SelectField
						label={<Trans>Supplier</Trans>}
						testId="new-order-supplier"
						placeholder={t`Choose a supplier`}
						options={choices.map((supplier) => ({
							value: supplier.id,
							label: supplier.name,
						}))}
						value={supplierId}
						onValueChange={setSupplierId}
					/>
				)}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={pending}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						disabled={pending || supplierId === ''}
						onClick={() => onCreate(supplierId)}
						data-testid="new-order-submit"
					>
						<Trans>Start order</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
