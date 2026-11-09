import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { type PriceAlert, type PriceAlerts } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePanel } from '@repo/ui/workspace'
import { Link } from 'react-router'
import { type InventoryQuery } from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { percentFromBp } from '#app/utils/inventory/today-view.ts'

const SHOWN = 5

function PriceAlertRow({
	alert,
	href,
	currency,
}: {
	alert: PriceAlert
	href: string
	currency: string
}) {
	const { i18n } = useLingui()
	const name = alert.itemName
	const supplier = alert.supplierName
	const percent = percentFromBp(alert.changeBp)
	const pack = alert.packName
	const was =
		alert.previousPackPriceMinor !== null
			? formatMoney(alert.previousPackPriceMinor, currency, i18n.locale)
			: null
	const now =
		alert.packPriceMinor !== null
			? formatMoney(alert.packPriceMinor, currency, i18n.locale)
			: null
	const dishes = alert.affectedDishes
	return (
		<li
			className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
			data-testid={`price-alert-${alert.itemId}`}
		>
			<div className="flex min-w-0 flex-col gap-1">
				<p className="text-sm text-pretty">
					<span className="font-medium wrap-anywhere">{name}</span>{' '}
					<Trans>
						went up <bdi dir="ltr">{percent}%</bdi>
					</Trans>
					{supplier ? (
						<>
							{' '}
							<Trans>
								at <span className="wrap-anywhere">{supplier}</span>
							</Trans>
						</>
					) : null}
					.{' '}
					{was && now && pack ? (
						<span className="text-muted-foreground">
							<Trans>
								A {pack} was <bdi dir="ltr">{was}</bdi>, now{' '}
								<bdi dir="ltr">{now}</bdi>.
							</Trans>
						</span>
					) : null}{' '}
					{dishes !== null && dishes > 0 ? (
						<span className="text-muted-foreground">
							<Plural
								value={dishes}
								one="# dish costs more now."
								other="# dishes cost more now."
							/>
						</span>
					) : null}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{alert.severity === 'big' ? (
					<Badge variant="destructive">
						<Trans>Big rise</Trans>
					</Badge>
				) : null}
				<Button
					variant="outline"
					size="sm"
					render={<Link to={href} />}
					data-testid={`price-alert-link-${alert.itemId}`}
				>
					<Trans>See delivery</Trans>
				</Button>
			</div>
		</li>
	)
}

/**
 * "Prices went up": items whose last delivery cost more than 5% over the one
 * before. The whole answer is money, so it is asked for only with the cost
 * grant; the region answers 403 otherwise.
 */
export function PriceAlertsPanel({
	query,
	basePath,
	search,
	currency,
}: {
	query: InventoryQuery<PriceAlerts>
	basePath: string
	search: string
	currency: string
}) {
	const { i18n } = useLingui()
	const alerts = query.data?.alerts ?? []
	// A quiet panel: no rises (or a failed read) leaves the page without it.
	if (query.error && !query.data) {
		return (
			<WorkspacePanel title={<Trans>Prices went up</Trans>}>
				<Alert variant="destructive" data-testid="price-alerts-error">
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
			</WorkspacePanel>
		)
	}
	if (!query.data) return <Skeleton className="h-10 w-full" />
	if (alerts.length === 0) return null
	return (
		<WorkspacePanel title={<Trans>Prices went up</Trans>}>
			<ul
				className="flex flex-col divide-y rounded-xl border"
				data-testid="price-alerts"
			>
				{alerts.slice(0, SHOWN).map((alert) => (
					<PriceAlertRow
						key={`${alert.itemId}-${alert.deliveryId}`}
						alert={alert}
						href={`${basePath}/deliveries/${encodeURIComponent(alert.deliveryId)}${search}`}
						currency={query.data?.currency ?? currency}
					/>
				))}
			</ul>
		</WorkspacePanel>
	)
}
