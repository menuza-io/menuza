import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { z } from 'zod'
import {
	formatMoney,
	orderSchema,
	type Order,
} from '#app/utils/orders/order-model.ts'
import { ordersHref } from '#app/utils/orders/orders-link.ts'
import { OrderStatusLabel, PaymentStatusLabel } from './order-status.tsx'

/**
 * Order History tab (#224): search, filter, sort, paginate (50/page) and
 * export CSV of past orders.
 *
 * Data residency invariant: the search query `q` (which may hold a guest's
 * name or phone) lives ONLY in the URL fragment (`#q=...`) and is sent from
 * the browser directly to the regional tenant-api. It NEVER enters the URL
 * query string and NEVER reaches the US App server on reload or shared links.
 */

const historyResponseSchema = z.object({
	orders: z.array(orderSchema),
	nextCursor: z.string().nullable().optional(),
	totalCount: z.number().int().optional(),
})

function readHashQuery(): string {
	if (typeof window === 'undefined') return ''
	const raw = window.location.hash.startsWith('#')
		? window.location.hash.slice(1)
		: ''
	return new URLSearchParams(raw).get('q') ?? ''
}

function writeHashQuery(q: string) {
	if (typeof window === 'undefined') return
	const trimmed = q.trim()
	const nextHash = trimmed ? `#q=${encodeURIComponent(trimmed)}` : ''
	const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`
	window.history.replaceState(null, '', nextUrl)
}

export function OrderHistoryTab({
	orgSlug,
	locations,
	request,
	tenantApiUrl,
	getAuthHeader,
}: {
	orgSlug: string
	locations: Array<{ id: string; name: string }>
	request: (path: string, init?: RequestInit) => Promise<unknown>
	tenantApiUrl: string
	getAuthHeader?: () => Promise<string | null>
}) {
	const { _, i18n } = useLingui()
	const [searchParams, setSearchParams] = useSearchParams()
	const [q, setQ] = useState<string>(() => readHashQuery())
	const [orders, setOrders] = useState<Order[]>([])
	const [nextCursor, setNextCursor] = useState<string | null>(null)
	const [totalCount, setTotalCount] = useState<number>(0)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [exporting, setExporting] = useState(false)
	const [exportNotice, setExportNotice] = useState<string | null>(null)

	const from = searchParams.get('from') ?? ''
	const to = searchParams.get('to') ?? ''
	const status = searchParams.get('status') ?? ''
	const fulfillment = searchParams.get('fulfillment') ?? ''
	const channel = searchParams.get('channel') ?? ''
	const paymentMethod = searchParams.get('paymentMethod') ?? ''
	const taxExempt = searchParams.get('taxExempt') ?? ''
	const locationId = searchParams.get('locationId') ?? ''
	const sort = searchParams.get('sort') ?? 'created_desc'
	const cursor = searchParams.get('cursor') ?? ''

	const updateParam = (key: string, value: string) => {
		const next = new URLSearchParams(searchParams)
		next.set('tab', 'history')
		if (value) next.set(key, value)
		else next.delete(key)
		if (key !== 'cursor') next.delete('cursor')
		setSearchParams(next, { replace: true })
	}

	const resetFilters = () => {
		setQ('')
		writeHashQuery('')
		const next = new URLSearchParams()
		next.set('tab', 'history')
		setSearchParams(next, { replace: true })
	}

	const buildApiQuery = useCallback(() => {
		const params = new URLSearchParams()
		params.set('limit', '50')
		if (from) params.set('from', from)
		if (to) params.set('to', to)
		if (q.trim()) params.set('q', q.trim())
		if (status) params.set('status', status)
		if (fulfillment) params.set('fulfillment', fulfillment)
		if (channel) params.set('channel', channel)
		if (paymentMethod) params.set('paymentMethod', paymentMethod)
		if (taxExempt) params.set('taxExempt', taxExempt)
		if (locationId) params.set('locationId', locationId)
		if (sort) params.set('sort', sort)
		if (cursor) params.set('cursor', cursor)
		return params.toString()
	}, [
		from,
		to,
		q,
		status,
		fulfillment,
		channel,
		paymentMethod,
		taxExempt,
		locationId,
		sort,
		cursor,
	])

	const load = useCallback(
		async (signal?: AbortSignal) => {
			setLoading(true)
			try {
				const qs = buildApiQuery()
				const data = historyResponseSchema.parse(
					await request(`?${qs}`, { signal }),
				)
				if (signal?.aborted) return
				setOrders(data.orders)
				setNextCursor(data.nextCursor ?? null)
				setTotalCount(data.totalCount ?? data.orders.length)
				setError(null)
			} catch {
				if (!signal?.aborted) {
					setError(_(msg`Unable to load order history. Try again.`))
				}
			} finally {
				if (!signal?.aborted) setLoading(false)
			}
		},
		[buildApiQuery, request, _],
	)

	useEffect(() => {
		const controller = new AbortController()
		void load(controller.signal)
		return () => controller.abort()
	}, [load])

	const handleExport = async () => {
		setExporting(true)
		setExportNotice(null)
		try {
			const qs = buildApiQuery()
			const authHeader = getAuthHeader ? await getAuthHeader() : null
			const res = await fetch(`${tenantApiUrl}/operator/orders/export?${qs}`, {
				headers: authHeader ? { Authorization: authHeader } : undefined,
				cache: 'no-store',
			})
			if (!res.ok) {
				setExportNotice(
					_(msg`Export failed. Narrow your date range and try again.`),
				)
				return
			}
			const truncated = res.headers.get('X-Export-Truncated') === 'true'
			const blob = await res.blob()
			const url = URL.createObjectURL(blob)
			const a = document.createElement('a')
			a.href = url
			a.download = 'orders-history.csv'
			a.click()
			URL.revokeObjectURL(url)
			if (truncated) {
				setExportNotice(
					_(
						msg`Export was capped at 50,000 rows. Narrow your filters to export all matching orders.`,
					),
				)
			}
		} catch {
			setExportNotice(_(msg`Could not export CSV.`))
		} finally {
			setExporting(false)
		}
	}

	const money = (cents: number, currency: string) =>
		formatMoney(cents, currency, i18n.locale)

	return (
		<div className="space-y-4" data-testid="order-history-tab">
			<div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4">
				<div className="sm:col-span-2">
					<label className="mb-1 block text-xs font-medium">
						<Trans>Search (order #, guest, phone, dish)</Trans>
					</label>
					<Input
						value={q}
						onChange={(e) => {
							const val = e.target.value
							setQ(val)
							writeHashQuery(val)
						}}
						placeholder={_(msg`Search orders…`)}
					/>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium">
						<Trans>From</Trans>
					</label>
					<Input
						type="date"
						value={from}
						onChange={(e) => updateParam('from', e.target.value)}
					/>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium">
						<Trans>To</Trans>
					</label>
					<Input
						type="date"
						value={to}
						onChange={(e) => updateParam('to', e.target.value)}
					/>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium">
						<Trans>Status</Trans>
					</label>
					<select
						className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
						value={status}
						onChange={(e) => updateParam('status', e.target.value)}
					>
						<option value="">{_(msg`All statuses`)}</option>
						<option value="accepted">{_(msg`Accepted`)}</option>
						<option value="preparing">{_(msg`Preparing`)}</option>
						<option value="ready">{_(msg`Ready`)}</option>
						<option value="completed">{_(msg`Completed`)}</option>
						<option value="cancelled">{_(msg`Cancelled`)}</option>
					</select>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium">
						<Trans>Type</Trans>
					</label>
					<select
						className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
						value={fulfillment}
						onChange={(e) => updateParam('fulfillment', e.target.value)}
					>
						<option value="">{_(msg`All types`)}</option>
						<option value="pickup">{_(msg`Pickup`)}</option>
						<option value="delivery">{_(msg`Delivery`)}</option>
						<option value="dine_in">{_(msg`Dine-in`)}</option>
					</select>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium">
						<Trans>Channel</Trans>
					</label>
					<select
						className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
						value={channel}
						onChange={(e) => updateParam('channel', e.target.value)}
					>
						<option value="">{_(msg`All channels`)}</option>
						<option value="online">{_(msg`Online`)}</option>
						<option value="qr">{_(msg`QR tab`)}</option>
						<option value="catering">{_(msg`Catering`)}</option>
					</select>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium">
						<Trans>Payment</Trans>
					</label>
					<select
						className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
						value={paymentMethod}
						onChange={(e) => updateParam('paymentMethod', e.target.value)}
					>
						<option value="">{_(msg`All payment methods`)}</option>
						<option value="online">{_(msg`Paid online`)}</option>
						<option value="handoff">{_(msg`Pay at handoff`)}</option>
					</select>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium">
						<Trans>Tax exempt</Trans>
					</label>
					<select
						className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
						value={taxExempt}
						onChange={(e) => updateParam('taxExempt', e.target.value)}
					>
						<option value="">{_(msg`All orders`)}</option>
						<option value="true">{_(msg`Tax exempt only`)}</option>
						<option value="false">{_(msg`Taxable only`)}</option>
					</select>
				</div>
				{locations.length > 1 ? (
					<div>
						<label className="mb-1 block text-xs font-medium">
							<Trans>Location</Trans>
						</label>
						<select
							className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
							value={locationId}
							onChange={(e) => updateParam('locationId', e.target.value)}
						>
							<option value="">{_(msg`All locations`)}</option>
							{locations.map((loc) => (
								<option key={loc.id} value={loc.id}>
									{loc.name}
								</option>
							))}
						</select>
					</div>
				) : null}
				<div>
					<label className="mb-1 block text-xs font-medium">
						<Trans>Sort</Trans>
					</label>
					<select
						className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
						value={sort}
						onChange={(e) => updateParam('sort', e.target.value)}
					>
						<option value="created_desc">{_(msg`Newest first`)}</option>
						<option value="created_asc">{_(msg`Oldest first`)}</option>
						<option value="total_desc">{_(msg`Highest total`)}</option>
						<option value="total_asc">{_(msg`Lowest total`)}</option>
					</select>
				</div>
				<div className="flex items-end gap-2">
					<Button type="button" variant="outline" onClick={resetFilters}>
						<Trans>Reset filters</Trans>
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={exporting}
						onClick={() => void handleExport()}
					>
						<Icon name="download" className="size-4" />
						<Trans>Export CSV</Trans>
					</Button>
				</div>
			</div>

			{exportNotice ? (
				<p role="status" className="text-muted-foreground text-sm">
					{exportNotice}
				</p>
			) : null}
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}

			<div className="overflow-x-auto rounded-lg border">
				<table className="w-full text-start text-sm">
					<thead className="bg-muted/50 border-b text-xs uppercase">
						<tr>
							<th className="px-3 py-2 text-start">
								<Trans>Order</Trans>
							</th>
							<th className="px-3 py-2 text-start">
								<Trans>Date</Trans>
							</th>
							<th className="px-3 py-2 text-start">
								<Trans>Status</Trans>
							</th>
							<th className="px-3 py-2 text-start">
								<Trans>Type</Trans>
							</th>
							<th className="px-3 py-2 text-end">
								<Trans>Total</Trans>
							</th>
						</tr>
					</thead>
					<tbody className="divide-y">
						{loading ? (
							<tr>
								<td
									colSpan={5}
									className="text-muted-foreground px-3 py-6 text-center"
								>
									<Trans>Loading order history…</Trans>
								</td>
							</tr>
						) : orders.length === 0 ? (
							<tr>
								<td
									colSpan={5}
									className="text-muted-foreground px-3 py-6 text-center"
								>
									<Trans>No orders match these filters.</Trans>
								</td>
							</tr>
						) : (
							orders.map((order) => (
								<tr key={order.id} className="hover:bg-muted/30">
									<td className="px-3 py-2 font-medium">
										<Link
											to={ordersHref(orgSlug, { orderId: order.id })}
											className="underline-offset-4 hover:underline"
										>
											#{order.number}
										</Link>
										{order.taxExempt ? (
											<Badge variant="outline" className="ms-2">
												<Trans>Tax exempt</Trans>
											</Badge>
										) : null}
									</td>
									<td className="text-muted-foreground px-3 py-2">
										{order.createdAt
											? new Date(order.createdAt).toLocaleString(i18n.locale)
											: '—'}
									</td>
									<td className="px-3 py-2">
										<OrderStatusLabel status={order.status} />{' '}
										<PaymentStatusLabel status={order.paymentStatus} />
									</td>
									<td className="px-3 py-2 capitalize">{order.fulfillment}</td>
									<td className="px-3 py-2 text-end font-medium tabular-nums">
										{money(order.totalCents, order.currency)}
									</td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>

			<div className="flex items-center justify-between text-sm">
				<span className="text-muted-foreground">
					<Trans>{totalCount} matching orders</Trans>
				</span>
				<div className="flex gap-2">
					{cursor ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => updateParam('cursor', '')}
						>
							<Trans>First page</Trans>
						</Button>
					) : null}
					{nextCursor ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => updateParam('cursor', nextCursor)}
						>
							<Trans>Next page</Trans>
						</Button>
					) : null}
				</div>
			</div>
		</div>
	)
}
