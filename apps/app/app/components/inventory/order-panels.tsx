import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	type listOrdersResultSchema,
	type OrderSummary,
	orderDetailSchema,
	type SuggestedOrders,
	type SuggestedSupplierOrder,
	type Supplier,
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
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { type z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
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
			) : data.suppliers.length === 0 && data.unsourced.length === 0 ? (
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
			{canReceive ? (
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
