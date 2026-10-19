import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { userHasOrganizationPermission } from '@repo/auth'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { PageTitle } from '@repo/ui/page-title'
import { useCallback, useEffect, useState } from 'react'
import {
	data,
	type LoaderFunctionArgs,
	Link,
	useLoaderData,
	useSearchParams,
} from 'react-router'
import { z } from 'zod'
import { useOrdersClient } from '#app/hooks/use-orders-client.ts'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import { getOrderCustomerLinkAccess } from '#app/utils/orders/customer-link.server.ts'
import { ORDER_STATUS_LABELS } from '#app/utils/orders/status-label.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { customersHref } from '#app/utils/people/customers-link.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true },
	)
	const userId = await requireMenuRead(request, organization.id)
	const canWrite = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_MENU_ANY,
	)
	const link = await getOrderCustomerLinkAccess(request, params.orgSlug || '')
	return data(
		{
			orgSlug: params.orgSlug || '',
			canWrite,
			// Customers links show only to members who can open Customers.
			canViewCustomers: link.linkCustomers || link.linkGuests,
		},
		{
			headers: { 'Cache-Control': 'private, no-store' },
		},
	)
}

// Mirrors operatorOrder() in apps/tenant-api/src/services/order-service.ts.
const orderSchema = z.object({
	id: z.string(),
	/** `c_<id>` or `g_<id>` person key, null for a guest checkout (or no access). */
	customerKey: z.string().nullable().optional(),
	number: z.string(),
	status: z.string(),
	paymentStatus: z.string(),
	paymentMethod: z.enum(['handoff', 'online']),
	totalCents: z.number().int(),
	currency: z.string(),
	createdAt: z.string().nullable(),
	contact: z.object({
		name: z.string(),
		phone: z.string(),
		email: z.string().nullable(),
	}),
	fulfillment: z.string(),
	location: z.object({ id: z.string(), name: z.string() }),
	lines: z.array(
		z.object({
			itemName: z.string(),
			quantity: z.number(),
			unitPriceCents: z.number(),
			totalCents: z.number(),
			instructions: z.string().nullable(),
			options: z.array(
				z.object({
					optionName: z.string(),
					quantity: z.number(),
				}),
			),
		}),
	),
	pickup: z
		.object({
			date: z.string(),
			time: z.string(),
			timezone: z.string(),
		})
		.nullable(),
	drop: z.object({ slug: z.string() }).nullable(),
	delivery: z
		.object({
			address: z.string(),
			city: z.string().nullable(),
			unit: z.string().nullable(),
			notes: z.string().nullable(),
		})
		.nullable(),
})
type Order = z.infer<typeof orderSchema>

/**
 * Receipt lines preserve every catalog locale as a JSON map string
 * (`{"en":"…","ar":"…"}`). Operators read them in their own locale.
 */
function localizedName(value: string, locale: string): string {
	if (!value.startsWith('{')) return value
	try {
		const parsed: unknown = JSON.parse(value)
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const record = parsed as Record<string, unknown>
			const picked =
				record[locale] ??
				record[locale.split('-')[0] ?? ''] ??
				record.en ??
				Object.values(record).find((entry) => typeof entry === 'string')
			if (typeof picked === 'string') return picked
		}
	} catch {
		// Not a locale map; fall through to the raw value.
	}
	return value
}

export default function OrdersInbox() {
	const { orgSlug, canWrite, canViewCustomers } = useLoaderData<typeof loader>()
	const [searchParams, setSearchParams] = useSearchParams()
	const selectedId = searchParams.get('order')
	const [deepLinked, setDeepLinked] = useState<Order | null>(null)
	const { _, i18n } = useLingui()
	const request = useOrdersClient(orgSlug)
	const [orders, setOrders] = useState<Order[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [markPaid, setMarkPaid] = useState(false)
	const [cancelRequested, setCancelRequested] = useState(false)
	const selected =
		orders.find((order) => order.id === selectedId) ??
		(deepLinked?.id === selectedId ? deepLinked : undefined)
	const select = (id: string | null) => {
		setSearchParams(
			(previous) => {
				const next = new URLSearchParams(previous)
				if (id) next.set('order', id)
				else next.delete('order')
				return next
			},
			{ replace: true, preventScrollReset: true },
		)
	}
	const money = (cents: number, currency: string) =>
		new Intl.NumberFormat(i18n.locale, {
			style: 'currency',
			currency,
		}).format(cents / 100)
	const statusText = (order: Order) => {
		if (
			order.paymentMethod === 'online' &&
			order.paymentStatus === 'pending' &&
			order.status === 'accepted'
		)
			return _(msg`Awaiting payment`)
		const label = ORDER_STATUS_LABELS[order.status]
		return label ? _(label) : order.status
	}

	const refresh = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const payload = z
					.object({ orders: z.array(orderSchema) })
					.parse(await request('', { signal }))
				if (signal?.aborted) return
				setOrders(payload.orders)
				setError(null)
			} catch {
				if (!signal?.aborted)
					setError(_(msg`Unable to load orders. Try again.`))
			} finally {
				if (!signal?.aborted) setLoading(false)
			}
		},
		[request, _],
	)

	useEffect(() => {
		const controller = new AbortController()
		setOrders([])
		setLoading(true)
		void refresh(controller.signal)
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible')
				void refresh(controller.signal)
		}, 15000)
		return () => {
			controller.abort()
			window.clearInterval(timer)
		}
	}, [refresh])

	// A deep link (`?order=<id>`) to an order outside the newest page loads
	// that one order, so the link always opens its detail.
	useEffect(() => {
		if (loading || !selectedId) return
		if (orders.some((order) => order.id === selectedId)) return
		if (deepLinked?.id === selectedId) return
		const controller = new AbortController()
		void request(`/${encodeURIComponent(selectedId)}`, {
			signal: controller.signal,
		})
			.then((raw) => {
				const parsed = z.object({ order: orderSchema }).safeParse(raw)
				if (parsed.success && !controller.signal.aborted)
					setDeepLinked(parsed.data.order)
			})
			.catch(() => {
				if (!controller.signal.aborted)
					setError(_(msg`That order could not be found.`))
			})
		return () => controller.abort()
	}, [loading, selectedId, orders, deepLinked, request, _])

	const update = async (status: string) => {
		if (!selected || busy || !canWrite) return
		setBusy(true)
		try {
			await request(`/${encodeURIComponent(selected.id)}`, {
				method: 'PATCH',
				body: JSON.stringify({ status, markPaid }),
			})
			setCancelRequested(false)
			setMarkPaid(false)
			setDeepLinked(null)
			await refresh()
		} catch {
			setError(_(msg`Unable to update this order. Refresh and try again.`))
		} finally {
			setBusy(false)
		}
	}
	const nextStatus = selected
		? {
				accepted: 'preparing',
				preparing: 'ready',
				ready: 'completed',
			}[selected.status]
		: undefined

	return (
		<div className="mx-auto w-full max-w-6xl space-y-6 py-8 md:px-6 lg:px-8">
			<div className="flex items-start justify-between gap-4">
				<PageTitle
					title={_(msg`Orders`)}
					description={_(
						msg`Receive and manage menu and drop orders. Updates refresh every 15 seconds.`,
					)}
				/>
				<Button
					variant="outline"
					onClick={() => void refresh()}
					disabled={busy}
				>
					<Trans>Refresh</Trans>
				</Button>
			</div>
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			{loading ? (
				<p role="status">
					<Trans>Loading orders…</Trans>
				</p>
			) : orders.length === 0 && !error ? (
				<div className="rounded-lg border p-8 text-center">
					<h3 className="font-medium">
						<Trans>No orders yet</Trans>
					</h3>
					<p className="text-muted-foreground mt-2 text-sm">
						<Trans>Submitted orders will appear here.</Trans>
					</p>
				</div>
			) : (
				<div className="grid items-start gap-6 lg:grid-cols-2">
					<div className="divide-border divide-y rounded-lg border">
						{orders.map((order) => (
							<button
								type="button"
								key={order.id}
								aria-pressed={selectedId === order.id}
								onClick={() => {
									select(order.id)
									setMarkPaid(false)
									setCancelRequested(false)
								}}
								className="hover:bg-muted focus-visible:ring-ring flex w-full flex-col gap-2 p-4 text-start focus-visible:ring-2 focus-visible:outline-none"
							>
								<span className="flex items-center justify-between gap-3">
									<span className="font-medium">{order.number}</span>
									<Badge
										variant={
											order.status === 'payment_review'
												? 'destructive'
												: 'secondary'
										}
									>
										{statusText(order)}
									</Badge>
								</span>
								<span className="flex items-center justify-between text-sm">
									<span className="flex min-w-0 items-center gap-2">
										<span className="truncate">{order.contact.name}</span>
										{canViewCustomers ? (
											<Badge
												variant="outline"
												data-testid="order-customer-kind"
											>
												{order.customerKey
													? _(msg`Customer`)
													: _(msg`Guest checkout`)}
											</Badge>
										) : null}
									</span>
									<span>{money(order.totalCents, order.currency)}</span>
								</span>
								<span className="text-muted-foreground text-xs">
									{order.createdAt
										? new Date(order.createdAt).toLocaleString(i18n.locale)
										: ''}
								</span>
							</button>
						))}
					</div>
					{selected ? (
						<section
							className="space-y-5 rounded-lg border p-5"
							aria-label={_(msg`Order details`)}
						>
							<div className="flex items-center justify-between gap-3">
								<h3 className="text-lg font-semibold">{selected.number}</h3>
								<Badge variant="secondary">{statusText(selected)}</Badge>
							</div>
							<div className="space-y-1 text-sm">
								<p className="font-medium">{selected.contact.name}</p>
								<a
									className="text-primary underline"
									href={`tel:${selected.contact.phone}`}
								>
									{selected.contact.phone}
								</a>
								{selected.contact.email ? (
									<p>{selected.contact.email}</p>
								) : null}
								{canViewCustomers ? (
									<div
										className="flex flex-wrap items-center gap-2 pt-1"
										data-testid="order-customer"
									>
										{selected.customerKey ? (
											<Button
												variant="outline"
												size="sm"
												render={
													<Link
														to={customersHref(orgSlug, {
															personKey: selected.customerKey,
														})}
													/>
												}
												data-testid="order-customer-link"
											>
												<Trans>View customer</Trans>
											</Button>
										) : (
											<Badge variant="outline">
												<Trans>Guest checkout</Trans>
											</Badge>
										)}
									</div>
								) : null}
								<p>
									{selected.fulfillment === 'delivery'
										? _(msg`Delivery`)
										: _(msg`Pickup`)}
								</p>
								{selected.pickup ? (
									<p>
										{localizedName(selected.location.name, i18n.locale)} ·{' '}
										{selected.pickup.date} · {selected.pickup.time}
									</p>
								) : null}
								{selected.delivery ? (
									<p>
										{selected.delivery.address}
										{selected.delivery.unit
											? `, ${selected.delivery.unit}`
											: ''}
										{selected.delivery.city
											? `, ${selected.delivery.city}`
											: ''}
									</p>
								) : null}
								{selected.delivery?.notes ? (
									<p className="text-muted-foreground">
										{selected.delivery.notes}
									</p>
								) : null}
							</div>
							<ul className="divide-border divide-y border-y">
								{selected.lines.map((line, index) => (
									<li key={index} className="py-3 text-sm">
										<p className="flex justify-between gap-3">
											<span>
												{line.quantity} ×{' '}
												{localizedName(line.itemName, i18n.locale)}
											</span>
											<span>{money(line.totalCents, selected.currency)}</span>
										</p>
										{line.options.length ? (
											<p className="text-muted-foreground mt-1">
												{line.options
													.map((option) =>
														option.quantity > 1
															? `${option.quantity} × ${localizedName(option.optionName, i18n.locale)}`
															: localizedName(option.optionName, i18n.locale),
													)
													.join(', ')}
											</p>
										) : null}
										{line.instructions ? (
											<p className="mt-1">{line.instructions}</p>
										) : null}
									</li>
								))}
							</ul>
							<p className="flex justify-between font-medium">
								<Trans>Total</Trans>
								<span>{money(selected.totalCents, selected.currency)}</span>
							</p>
							<p className="text-sm">
								{selected.paymentStatus === 'paid'
									? _(msg`Paid online or at handoff`)
									: _(msg`Payment not yet received`)}
							</p>
							{canWrite && nextStatus ? (
								<div className="space-y-4">
									{selected.paymentMethod === 'handoff' &&
									selected.paymentStatus !== 'paid' &&
									nextStatus === 'completed' ? (
										<label className="flex items-center gap-2 text-sm">
											<Checkbox
												checked={markPaid}
												onCheckedChange={(checked) =>
													setMarkPaid(checked === true)
												}
											/>
											<Trans>I have received payment at handoff</Trans>
										</label>
									) : null}
									<Button
										onClick={() => void update(nextStatus)}
										disabled={
											busy ||
											(nextStatus === 'completed' &&
												selected.paymentStatus !== 'paid' &&
												!markPaid)
										}
									>
										{nextStatus === 'preparing'
											? _(msg`Start preparing`)
											: nextStatus === 'ready'
												? _(msg`Mark ready`)
												: _(msg`Complete order`)}
									</Button>
								</div>
							) : null}
							{canWrite &&
							!['completed', 'cancelled', 'expired'].includes(
								selected.status,
							) ? (
								<div className="space-y-2 border-t pt-4">
									{cancelRequested ? (
										<>
											<p className="text-sm">
												<Trans>
													Cancel this order? Any captured payment requires a
													separate refund with your payment processor.
												</Trans>
											</p>
											<div className="flex gap-2">
												<Button
													variant="destructive"
													disabled={busy}
													onClick={() => void update('cancelled')}
												>
													<Trans>Confirm cancellation</Trans>
												</Button>
												<Button
													variant="outline"
													disabled={busy}
													onClick={() => setCancelRequested(false)}
												>
													<Trans>Keep order</Trans>
												</Button>
											</div>
										</>
									) : (
										<Button
											variant="outline"
											onClick={() => setCancelRequested(true)}
										>
											<Trans>Cancel order</Trans>
										</Button>
									)}
								</div>
							) : null}
						</section>
					) : (
						<p className="text-muted-foreground py-8 text-center text-sm">
							<Trans>Select an order to view its details.</Trans>
						</p>
					)}
				</div>
			)}
		</div>
	)
}
