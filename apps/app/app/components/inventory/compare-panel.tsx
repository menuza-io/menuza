import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { type CompareRow, compareSchema } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePanel } from '@repo/ui/workspace'
import { Link } from 'react-router'
import { type InventoryChromeLocation } from '#app/components/inventory/inventory-chrome.tsx'
import { useInventoryQuery } from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { percentFromBp } from '#app/utils/inventory/today-view.ts'

/**
 * The same few numbers for every place, side by side, so an owner can see
 * which branch is off: items low or out, the last count, this week's waste,
 * stock on the way, and (with the cost grant) stock value and food cost. A row
 * opens that place's own Today.
 */
export function ComparePanel({
	locations,
	activeLocationId,
	canSeeCost,
	currency,
}: {
	locations: readonly InventoryChromeLocation[]
	activeLocationId: string
	canSeeCost: boolean
	currency: string
}) {
	const { i18n } = useLingui()
	const query = useInventoryQuery(
		`/compare?${new URLSearchParams({ locationIds: locations.map((place) => place.id).join(',') })}`,
		compareSchema,
	)
	return (
		<WorkspacePanel title={<Trans>All your places</Trans>}>
			{query.error && !query.data ? (
				<Alert variant="destructive" data-testid="compare-error">
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
				<Skeleton className="h-24 w-full" />
			) : (
				<ul className="flex flex-col gap-3" data-testid="compare-list">
					{query.data.rows.map((row) => (
						<CompareCard
							key={row.locationId}
							row={row}
							name={
								locations.find((place) => place.id === row.locationId)?.name ??
								row.locationId
							}
							active={row.locationId === activeLocationId}
							canSeeCost={canSeeCost}
							currency={currency}
						/>
					))}
				</ul>
			)}
		</WorkspacePanel>
	)
}

function Stat({
	label,
	children,
	testId,
}: {
	label: React.ReactNode
	children: React.ReactNode
	testId?: string
}) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-muted-foreground text-xs">{label}</dt>
			<dd className="text-sm tabular-nums" data-testid={testId}>
				{children}
			</dd>
		</div>
	)
}

function CompareCard({
	row,
	name,
	active,
	canSeeCost,
	currency,
}: {
	row: CompareRow
	name: string
	active: boolean
	canSeeCost: boolean
	currency: string
}) {
	const { i18n } = useLingui()
	const incoming = row.incomingTransfers
	const outgoing = row.outgoingTransfers
	const money = (minor: number) =>
		formatMoney(minor, row.currency ?? currency, i18n.locale)
	const lastCount = row.lastCountAt
		? new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(
				row.lastCountAt,
			)
		: null
	return (
		<li
			className="bg-card flex flex-col gap-3 rounded-xl border p-4"
			data-testid={`compare-${row.locationId}`}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="font-medium wrap-anywhere">{name}</span>
				{active ? (
					<Badge variant="outline">
						<Trans>Viewing</Trans>
					</Badge>
				) : (
					<Button
						variant="outline"
						size="sm"
						render={
							<Link
								to={`?${new URLSearchParams({ locationId: row.locationId })}`}
							/>
						}
						data-testid={`compare-open-${row.locationId}`}
					>
						<Trans>Open</Trans>
					</Button>
				)}
			</div>
			<dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Stat label={<Trans>Running low</Trans>} testId="compare-low">
					{row.lowItems}
				</Stat>
				<Stat label={<Trans>Out of stock</Trans>} testId="compare-out">
					{row.outItems}
				</Stat>
				<Stat label={<Trans>Last count</Trans>}>
					{lastCount ?? <Trans>Never counted</Trans>}
				</Stat>
				<Stat label={<Trans>Waste this week</Trans>}>
					<Plural value={row.wasteWeekCount} one="# entry" other="# entries" />
					{canSeeCost && row.wasteWeekMinor !== undefined ? (
						<>
							{' · '}
							<bdi dir="ltr">{money(row.wasteWeekMinor)}</bdi>
						</>
					) : null}
				</Stat>
				{row.incomingTransfers > 0 || row.outgoingTransfers > 0 ? (
					<Stat label={<Trans>Moving stock</Trans>}>
						<Trans>
							{incoming} in, {outgoing} out
						</Trans>
					</Stat>
				) : null}
				{canSeeCost && row.stockValueMinor !== undefined ? (
					<Stat label={<Trans>Stock value</Trans>}>
						<bdi dir="ltr">{money(row.stockValueMinor)}</bdi>
					</Stat>
				) : null}
				{canSeeCost && row.foodCost ? (
					<Stat label={<Trans>Food cost</Trans>} testId="compare-food-cost">
						{row.foodCost.state === 'ok' &&
						row.foodCost.bp !== null &&
						row.foodCost.bp !== undefined ? (
							<bdi dir="ltr">{percentFromBp(row.foodCost.bp)}%</bdi>
						) : row.foodCost.state === 'no_sales' ? (
							<Trans>No sales yet</Trans>
						) : (
							<Trans>Needs two counts</Trans>
						)}
					</Stat>
				) : null}
			</dl>
		</li>
	)
}
