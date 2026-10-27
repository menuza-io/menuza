import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@repo/ui/alert-dialog'
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

const PRODUCT_LABELS: Record<string, MessageDescriptor> = {
	table_card: msg`Table QR cards`,
	poster: msg`Poster`,
	flyer: msg`Flyer`,
}

const STATUS_LABELS: Record<string, MessageDescriptor> = {
	quote: msg`Price ready`,
	awaiting_payment: msg`Waiting for payment`,
	paid: msg`Paid`,
	submitting: msg`Sending to the printer`,
	cancelling: msg`Cancelling`,
	submitted: msg`Sent to the printer`,
	in_production: msg`Printing`,
	shipped: msg`Shipped`,
	delivered: msg`Delivered`,
	held: msg`On hold`,
	failed: msg`Failed`,
	cancelled: msg`Cancelled`,
	refunded: msg`Refunded`,
}

const HOLD_LABELS: Record<string, MessageDescriptor> = {
	price_drift: msg`Wholesale price rose past the drift limit`,
	render_unavailable: msg`The print file could not be made`,
	vendor_unavailable: msg`The vendor did not answer`,
	vendor_rejected: msg`The vendor refused the order`,
	vendor_failed: msg`The vendor failed the order`,
	vendor_cancelled: msg`The vendor cancelled the order`,
	cancelled_by_operator: msg`Cancelled by the organization`,
	refunded_by_admin: msg`Refunded by an admin`,
	payment_failed: msg`The payment failed`,
	submission_error: msg`Sending to the vendor failed unexpectedly`,
	refund_failed: msg`The vendor order was cancelled but the refund failed`,
}

/** A fetcher action that asks first: money and catalog changes are not undone. */
function ConfirmedAction({
	fetcher,
	fields,
	label,
	accessibleLabel,
	title,
	description,
	confirmLabel,
	variant = 'ghost',
	destructive = false,
}: {
	fetcher: ReturnType<typeof useFetcher<PrintAdminResult>>
	fields: Record<string, string>
	label: string
	accessibleLabel: string
	title: string
	description: string
	confirmLabel: string
	variant?: 'ghost' | 'outline' | 'default'
	destructive?: boolean
}) {
	const { _ } = useLingui()
	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={
					<Button
						size="sm"
						variant={variant}
						aria-label={accessibleLabel}
						disabled={fetcher.state !== 'idle'}
					>
						{label}
					</Button>
				}
			/>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{_(msg`Cancel`)}</AlertDialogCancel>
					<fetcher.Form method="POST">
						{Object.entries(fields).map(([name, value]) => (
							<input key={name} type="hidden" name={name} value={value} />
						))}
						<Button
							type="submit"
							variant={destructive ? 'destructive' : 'default'}
							disabled={fetcher.state !== 'idle'}
						>
							{confirmLabel}
						</Button>
					</fetcher.Form>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
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
				<span className="font-medium">
					{PRODUCT_LABELS[size.product]
						? _(PRODUCT_LABELS[size.product]!)
						: size.product}
				</span>{' '}
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
					<ConfirmedAction
						fetcher={fetcher}
						fields={{ _action: 'catalog-remove', id: current.id }}
						label={_(msg`Stop shipping`)}
						accessibleLabel={(() => {
							const sizeLabel = size.label
							return _(msg`Stop shipping ${sizeLabel}`)
						})()}
						title={_(msg`Stop shipping this size?`)}
						description={_(
							msg`No organization can order it shipped until it is enabled again. Downloads keep working.`,
						)}
						confirmLabel={_(msg`Stop shipping`)}
						destructive
					/>
				) : null}
			</TableCell>
		</TableRow>
	)
}

function OrderActions({
	order,
}: {
	order: {
		id: string
		status: string
		organization: string
		totalCents: number
	}
}) {
	const fetcher = useFetcher<PrintAdminResult>()
	const { _, i18n } = useLingui()
	const refundable = ![
		'refunded',
		'cancelled',
		'quote',
		'awaiting_payment',
	].includes(order.status)
	const organization = order.organization
	const amount = money(order.totalCents, i18n.locale)
	return (
		<div className="flex flex-wrap gap-2">
			{order.status === 'held' ? (
				<>
					<fetcher.Form method="POST">
						<input type="hidden" name="_action" value="retry" />
						<input type="hidden" name="orderId" value={order.id} />
						<Button
							type="submit"
							size="sm"
							disabled={fetcher.state !== 'idle'}
							aria-label={_(msg`Retry the order of ${organization}`)}
						>
							{_(msg`Retry`)}
						</Button>
					</fetcher.Form>
					<ConfirmedAction
						fetcher={fetcher}
						fields={{ _action: 'retry-accept', orderId: order.id }}
						label={_(msg`Accept new price`)}
						accessibleLabel={_(msg`Accept the new price for ${organization}`)}
						title={_(msg`Accept the new wholesale price?`)}
						description={_(
							msg`The order goes to the vendor at today's price. The organization already paid ${amount}; Menuza absorbs the difference.`,
						)}
						confirmLabel={_(msg`Accept and send`)}
						variant="outline"
					/>
				</>
			) : null}
			{refundable ? (
				<ConfirmedAction
					fetcher={fetcher}
					fields={{ _action: 'refund', orderId: order.id }}
					label={_(msg`Refund in full`)}
					accessibleLabel={_(msg`Refund the order of ${organization} in full`)}
					title={_(msg`Refund ${amount} to ${organization}?`)}
					description={_(
						msg`The full amount goes back to the card they paid with, and vendor orders still open are cancelled. This cannot be undone.`,
					)}
					confirmLabel={_(msg`Refund in full`)}
					destructive
				/>
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
											{STATUS_LABELS[order.status]
												? _(STATUS_LABELS[order.status]!)
												: order.status}
										</Badge>
										{order.holdReason || order.failureReason ? (
											<span className="text-muted-foreground block text-xs">
												{(() => {
													const reason = (order.holdReason ??
														order.failureReason)!
													return HOLD_LABELS[reason]
														? _(HOLD_LABELS[reason]!)
														: reason
												})()}
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
