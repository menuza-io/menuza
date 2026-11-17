import { Trans, useLingui } from '@lingui/react/macro'
import {
	DISCOUNT_PERFORMANCE_MIN_ORDERS,
	DISCOUNT_USAGE_MAX_IDS,
	type DiscountPerformanceBasis,
	type DiscountPerformanceEntry,
	type DiscountPerformanceResponse,
	discountPerformanceFigures,
} from '@repo/discounts'
import { Frame } from '@repo/ui/frame'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { formatMoney, numberText } from '#app/utils/discounts/labels.ts'
import { createDiscountUsageClient } from '#app/utils/discounts/usage-client.ts'

/**
 * How each discount performed (#390): the orders that used it, what those
 * orders sold, what it gave and the sales for each unit given. Figures follow
 * the reports' gross or net rule and the member's locations, and come from the
 * guests' region as ids and amounts: the names are the App's. A till discount
 * (applied by the cashier) has its own table. Below the order threshold a
 * discount shows its figures but no return, because a few orders say nothing
 * about whether it pays.
 */

export type PerformanceDiscount = {
	id: string
	name: string
	application: string
}

/** The calendar day a period starts on when none is chosen: 29 days back, so 30 days. */
export function defaultPerformancePeriod(today: string): {
	from: string
	to: string
} {
	const date = new Date(`${today}T00:00:00Z`)
	date.setUTCDate(date.getUTCDate() - 29)
	return { from: date.toISOString().slice(0, 10), to: today }
}

export function DiscountPerformance({
	orgSlug,
	currency,
	locale,
	discounts,
	from,
	to,
	timeZone,
}: {
	orgSlug: string
	currency: string
	locale: string
	discounts: readonly PerformanceDiscount[]
	/** `YYYY-MM-DD`, inclusive, read on `timeZone`'s calendar. */
	from: string
	to: string
	timeZone?: string
}) {
	const { t } = useLingui()
	const [basis, setBasis] = useState<DiscountPerformanceBasis>('net')
	const [result, setResult] = useState<DiscountPerformanceResponse | null>(null)
	const [failed, setFailed] = useState(false)
	const ids = useMemo(
		() =>
			discounts.map((discount) => discount.id).slice(0, DISCOUNT_USAGE_MAX_IDS),
		[discounts],
	)
	const idsKey = ids.join(',')

	useEffect(() => {
		if (ids.length === 0 || !from || !to || from > to) {
			setResult(null)
			setFailed(false)
			return
		}
		const controller = new AbortController()
		void createDiscountUsageClient({ orgSlug })
			.fetchPerformance(
				{ ids, from, to, tz: timeZone, basis },
				controller.signal,
			)
			.then((response) => {
				if (controller.signal.aborted) return
				setResult(response)
				setFailed(response === null)
			})
		return () => controller.abort()
		// `ids` follows `idsKey`.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [orgSlug, idsKey, from, to, timeZone, basis])

	const byId = useMemo(
		() => new Map(result?.entries.map((entry) => [entry.discountId, entry])),
		[result],
	)
	const used = discounts.filter((discount) => {
		const entry = byId.get(discount.id)
		return entry !== undefined && entry.orders > 0
	})
	const online = used.filter((discount) => discount.application !== 'manual')
	const till = used.filter((discount) => discount.application === 'manual')
	// One unit of money, the yardstick of the return column.
	const oneUnit = formatMoney(100, currency, locale)
	const share =
		result && result.ordersTotal > 0
			? Math.round((result.ordersWithDiscount / result.ordersTotal) * 100)
			: null

	return (
		<section
			aria-labelledby="discount-performance-title"
			className="flex flex-col gap-3"
		>
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="flex flex-col gap-1">
					<h2
						id="discount-performance-title"
						className="text-base font-semibold"
					>
						<Trans>How your discounts are doing</Trans>
					</h2>
					<p className="text-muted-foreground max-w-prose text-sm">
						<Trans>
							What the orders that used each discount sold, what the discount
							gave, and how much was sold for each {oneUnit} given. Orders that
							are paid and completed count.
						</Trans>
					</p>
				</div>
				<label
					htmlFor="discount-performance-basis"
					className="flex flex-col gap-1 text-sm"
				>
					<span className="font-medium">
						<Trans>Sales are counted</Trans>
					</span>
					<select
						id="discount-performance-basis"
						className="border-input bg-card h-8 min-w-40 rounded-md border px-2.5"
						value={basis}
						onChange={(event) =>
							setBasis(event.currentTarget.value as DiscountPerformanceBasis)
						}
					>
						<option value="net">{t`After discounts, without tax and tips`}</option>
						<option value="gross">{t`Before discounts, without tax and tips`}</option>
					</select>
				</label>
			</div>

			{failed ? (
				<p role="status" className="text-muted-foreground text-sm">
					<Trans>Performance figures are unavailable right now.</Trans>
				</p>
			) : result === null ? (
				<p role="status" className="text-muted-foreground text-sm">
					<Trans>Loading…</Trans>
				</p>
			) : (
				<>
					{share !== null ? (
						<p data-testid="discount-share" className="text-sm">
							{(() => {
								const percent = numberText(share, locale)
								const withDiscount = numberText(
									result.ordersWithDiscount,
									locale,
								)
								const total = numberText(result.ordersTotal, locale)
								return (
									<Trans>
										{percent}% of orders used a discount ({withDiscount} of{' '}
										{total}), till discounts included.
									</Trans>
								)
							})()}
						</p>
					) : null}
					{used.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>
								No discount was used on a completed order in this period.
							</Trans>
						</p>
					) : null}
					{online.length > 0 ? (
						<PerformanceTable
							caption={<Trans>Online and automatic discounts</Trans>}
							discounts={online}
							byId={byId}
							orgSlug={orgSlug}
							currency={currency}
							locale={locale}
						/>
					) : null}
					{till.length > 0 ? (
						<PerformanceTable
							caption={<Trans>Discounts the cashier applies at the till</Trans>}
							discounts={till}
							byId={byId}
							orgSlug={orgSlug}
							currency={currency}
							locale={locale}
						/>
					) : null}
				</>
			)}
		</section>
	)
}

function PerformanceTable({
	caption,
	discounts,
	byId,
	orgSlug,
	currency,
	locale,
}: {
	caption: React.ReactNode
	discounts: readonly PerformanceDiscount[]
	byId: ReadonlyMap<string, DiscountPerformanceEntry>
	orgSlug: string
	currency: string
	locale: string
}) {
	const oneUnit = formatMoney(100, currency, locale)
	return (
		<Frame className="w-full">
			<Table variant="card">
				<caption className="px-3 pt-3 pb-1 text-start text-sm font-medium">
					{caption}
				</caption>
				<TableHeader>
					<TableRow>
						<TableHead>
							<Trans>Discount</Trans>
						</TableHead>
						<TableHead className="text-end">
							<Trans>Orders</Trans>
						</TableHead>
						<TableHead className="text-end">
							<Trans>Sales</Trans>
						</TableHead>
						<TableHead className="text-end">
							<Trans>Discount given</Trans>
						</TableHead>
						<TableHead className="text-end">
							<Trans>Sold per {oneUnit} given</Trans>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{discounts.map((discount) => {
						const entry = byId.get(discount.id)!
						return (
							<PerformanceRow
								key={discount.id}
								discount={discount}
								entry={entry}
								orgSlug={orgSlug}
								currency={currency}
								locale={locale}
							/>
						)
					})}
				</TableBody>
			</Table>
		</Frame>
	)
}

function PerformanceRow({
	discount,
	entry,
	orgSlug,
	currency,
	locale,
}: {
	discount: PerformanceDiscount
	entry: DiscountPerformanceEntry
	orgSlug: string
	currency: string
	locale: string
}) {
	const { t } = useLingui()
	const figures = discountPerformanceFigures(entry)
	const minimum = DISCOUNT_PERFORMANCE_MIN_ORDERS
	return (
		<TableRow>
			<TableCell>
				<Link
					to={`/${orgSlug}/discounts/${discount.id}`}
					className="font-medium underline-offset-4 hover:underline"
				>
					{discount.name}
				</Link>
			</TableCell>
			<TableCell className="text-end tabular-nums">
				{numberText(entry.orders, locale)}
			</TableCell>
			<TableCell className="text-end tabular-nums">
				{formatMoney(entry.salesMinor, currency, locale)}
			</TableCell>
			<TableCell className="text-end tabular-nums">
				{formatMoney(entry.discountMinor, currency, locale)}
			</TableCell>
			<TableCell className="text-end tabular-nums">
				{!figures.enough ? (
					<span
						className="text-muted-foreground"
						title={t`Needs at least ${minimum} orders`}
					>
						<Trans>Not enough data</Trans>
					</span>
				) : figures.returnPerUnit === null ? (
					<span className="text-muted-foreground">—</span>
				) : (
					formatMoney(Math.round(figures.returnPerUnit * 100), currency, locale)
				)}
			</TableCell>
		</TableRow>
	)
}
