import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useId } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import {
	action,
	loader,
	PRINT_ADMIN_VENDORS,
	type PrintAdminResult,
} from './print-shop.server.ts'

export { action, loader }

function money(cents: number, locale: string) {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: 'USD',
	}).format(cents / 100)
}

function Result({ data }: { data: PrintAdminResult | undefined }) {
	if (!data) return null
	return data.ok ? (
		<p role="status" className="text-muted-foreground text-sm">
			<Trans>Saved.</Trans>
		</p>
	) : (
		<p role="alert" className="text-destructive text-sm">
			{data.message}
		</p>
	)
}

function SettingsCard({
	settings,
}: {
	settings: { markupBp: number; driftHoldBp: number; quoteTtlMinutes: number }
}) {
	const fetcher = useFetcher<PrintAdminResult>()
	const id = useId()
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Pricing rules</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Retail is the vendor's wholesale price plus the markup; shipping is
						passed through. A paid order whose wholesale price rose by more than
						the drift limit is held here.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<fetcher.Form method="POST" className="flex flex-wrap items-end gap-4">
					<input type="hidden" name="_action" value="settings" />
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-markup`}>
							<Trans>Markup (%)</Trans>
						</Label>
						<Input
							id={`${id}-markup`}
							name="markupPercent"
							inputMode="decimal"
							defaultValue={settings.markupBp / 100}
							className="w-28"
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-drift`}>
							<Trans>Drift limit (%)</Trans>
						</Label>
						<Input
							id={`${id}-drift`}
							name="driftPercent"
							inputMode="decimal"
							defaultValue={settings.driftHoldBp / 100}
							className="w-28"
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-ttl`}>
							<Trans>Quote valid (minutes)</Trans>
						</Label>
						<Input
							id={`${id}-ttl`}
							name="quoteTtlMinutes"
							inputMode="numeric"
							defaultValue={settings.quoteTtlMinutes}
							className="w-28"
						/>
					</div>
					<Button type="submit" disabled={fetcher.state !== 'idle'}>
						<Trans>Save</Trans>
					</Button>
				</fetcher.Form>
				<Result data={fetcher.data} />
			</CardContent>
		</Card>
	)
}

function CatalogCard({
	sizes,
	catalog,
}: {
	sizes: Array<{ product: string; sizeKey: string; label: string }>
	catalog: Array<{
		id: string
		product: string
		sizeKey: string
		vendor: string
		vendorSku: string
		bleedMm: number
	}>
}) {
	const { _ } = useLingui()
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Vendor catalog</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Each shippable product and size prints at one vendor. Changing the
						vendor here is how orders are rerouted: retrying a held order picks
						up the new mapping.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{_(msg`Product and size`)}</TableHead>
							<TableHead>{_(msg`Vendor`)}</TableHead>
							<TableHead>{_(msg`Vendor SKU`)}</TableHead>
							<TableHead>{_(msg`Bleed (mm)`)}</TableHead>
							<TableHead>
								<span className="sr-only">{_(msg`Actions`)}</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sizes.map((size) => {
							const current = catalog.find(
								(row) =>
									row.product === size.product && row.sizeKey === size.sizeKey,
							)
							return (
								<CatalogRow
									key={`${size.product}:${size.sizeKey}`}
									size={size}
									current={current}
								/>
							)
						})}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	)
}

function CatalogRow({
	size,
	current,
}: {
	size: { product: string; sizeKey: string; label: string }
	current?: { id: string; vendor: string; vendorSku: string; bleedMm: number }
}) {
	const fetcher = useFetcher<PrintAdminResult>()
	const { _ } = useLingui()
	const formId = `catalog-${size.product}-${size.sizeKey}`
	return (
		<TableRow>
			<TableCell>
				<span className="font-medium">{size.product}</span>{' '}
				<bdi className="text-muted-foreground">{size.label}</bdi>
				<fetcher.Form id={formId} method="POST">
					<input type="hidden" name="_action" value="catalog" />
					<input type="hidden" name="product" value={size.product} />
					<input type="hidden" name="sizeKey" value={size.sizeKey} />
				</fetcher.Form>
				<Result data={fetcher.data} />
			</TableCell>
			<TableCell>
				<select
					form={formId}
					name="vendor"
					defaultValue={current?.vendor ?? 'gelato'}
					aria-label={_(msg`Vendor`)}
					className="border-input bg-background h-9 rounded-md border px-2 text-sm"
				>
					{PRINT_ADMIN_VENDORS.map((vendor) => (
						<option key={vendor} value={vendor}>
							{vendor}
						</option>
					))}
				</select>
			</TableCell>
			<TableCell>
				<Input
					form={formId}
					name="vendorSku"
					defaultValue={current?.vendorSku ?? ''}
					aria-label={_(msg`Vendor SKU`)}
					className="min-w-48"
				/>
			</TableCell>
			<TableCell>
				<Input
					form={formId}
					name="bleedMm"
					inputMode="numeric"
					defaultValue={current?.bleedMm ?? 3}
					aria-label={_(msg`Bleed (mm)`)}
					className="w-20"
				/>
			</TableCell>
			<TableCell className="whitespace-nowrap">
				<Button
					type="submit"
					form={formId}
					size="sm"
					disabled={fetcher.state !== 'idle'}
				>
					{current ? _(msg`Update`) : _(msg`Enable`)}
				</Button>
				{current ? (
					<fetcher.Form method="POST" className="inline">
						<input type="hidden" name="_action" value="catalog-remove" />
						<input type="hidden" name="id" value={current.id} />
						<Button type="submit" size="sm" variant="ghost">
							{_(msg`Stop shipping`)}
						</Button>
					</fetcher.Form>
				) : null}
			</TableCell>
		</TableRow>
	)
}

function OrderActions({ order }: { order: { id: string; status: string } }) {
	const fetcher = useFetcher<PrintAdminResult>()
	const { _ } = useLingui()
	const refundable = ![
		'refunded',
		'cancelled',
		'quote',
		'awaiting_payment',
	].includes(order.status)
	return (
		<div className="flex flex-wrap gap-2">
			{order.status === 'held' ? (
				<>
					<fetcher.Form method="POST">
						<input type="hidden" name="_action" value="retry" />
						<input type="hidden" name="orderId" value={order.id} />
						<Button type="submit" size="sm" disabled={fetcher.state !== 'idle'}>
							{_(msg`Retry`)}
						</Button>
					</fetcher.Form>
					<fetcher.Form method="POST">
						<input type="hidden" name="_action" value="retry-accept" />
						<input type="hidden" name="orderId" value={order.id} />
						<Button
							type="submit"
							size="sm"
							variant="outline"
							disabled={fetcher.state !== 'idle'}
						>
							{_(msg`Accept new price`)}
						</Button>
					</fetcher.Form>
				</>
			) : null}
			{refundable ? (
				<fetcher.Form method="POST">
					<input type="hidden" name="_action" value="refund" />
					<input type="hidden" name="orderId" value={order.id} />
					<Button
						type="submit"
						size="sm"
						variant="ghost"
						disabled={fetcher.state !== 'idle'}
					>
						{_(msg`Refund in full`)}
					</Button>
				</fetcher.Form>
			) : null}
			<Result data={fetcher.data} />
		</div>
	)
}

export default function PrintShopAdminRoute() {
	const { _, i18n } = useLingui()
	const data = useLoaderData<typeof loader>()
	const margin = data.orders.reduce((sum, order) => sum + order.marginCents, 0)
	return (
		<div className="space-y-6">
			<PageHeader
				title={_(msg`Print shop`)}
				description={_(
					msg`Shipped prints across all organizations: pricing, vendors and orders.`,
				)}
			/>
			<SettingsCard settings={data.settings} />
			<CatalogCard sizes={data.sizes} catalog={data.catalog} />
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Orders</Trans>
					</CardTitle>
					<CardDescription>
						{(() => {
							const total = money(margin, i18n.locale)
							return _(msg`Margin on the last 100 orders: ${total}`)
						})()}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{_(msg`Organization`)}</TableHead>
								<TableHead>{_(msg`Status`)}</TableHead>
								<TableHead>{_(msg`Total`)}</TableHead>
								<TableHead>{_(msg`Wholesale`)}</TableHead>
								<TableHead>{_(msg`Margin`)}</TableHead>
								<TableHead>{_(msg`Placed`)}</TableHead>
								<TableHead>
									<span className="sr-only">{_(msg`Actions`)}</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.orders.map((order) => (
								<TableRow key={order.id}>
									<TableCell className="wrap-anywhere">
										{order.organization}
									</TableCell>
									<TableCell>
										<Badge
											variant={
												order.status === 'held' ? 'warning' : 'secondary'
											}
										>
											{order.status}
										</Badge>
										{order.holdReason || order.failureReason ? (
											<span className="text-muted-foreground block text-xs">
												{order.holdReason ?? order.failureReason}
											</span>
										) : null}
									</TableCell>
									<TableCell className="tabular-nums">
										{money(order.totalCents, i18n.locale)}
									</TableCell>
									<TableCell className="tabular-nums">
										{money(order.wholesaleCents, i18n.locale)}
									</TableCell>
									<TableCell className="tabular-nums">
										{money(order.marginCents, i18n.locale)}
									</TableCell>
									<TableCell>
										{new Date(order.createdAt).toLocaleString(i18n.locale)}
									</TableCell>
									<TableCell>
										<OrderActions order={order} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</CardContent>
			</Card>
		</div>
	)
}
