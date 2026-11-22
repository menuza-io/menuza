import { Trans, useLingui } from '@lingui/react/macro'
import { listGroupsResultSchema, type StockItem } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { GroupDialog } from '#app/components/inventory/group-dialog.tsx'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import {
	UsedInList,
	type UsedInNames,
	useUsedIn,
} from '#app/components/inventory/used-in-section.tsx'
import { SheetPanel } from '#app/components/staff/sheet-frame.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'

/**
 * An ingredient group on the item sheet: the members' total, each member's
 * stock and price, which one is used first, and where recipes use the group.
 */
export function GroupSheet({
	group,
	locationId,
	basePath,
	search,
	canEdit,
	canSeeCost,
	currency,
	orgSlug,
	names,
	recipesEnabled,
	onChanged,
	close,
}: {
	group: StockItem
	locationId: string
	basePath: string
	search: string
	canEdit: boolean
	canSeeCost: boolean
	currency: string
	orgSlug: string
	names: UsedInNames
	recipesEnabled: boolean
	onChanged: () => void
	close: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const groups = useInventoryQuery(
		`/groups?${new URLSearchParams({ locationId })}`,
		listGroupsResultSchema,
	)
	const used = useUsedIn(group.id, recipesEnabled)
	const [editing, setEditing] = useState(false)
	const detail = groups.data?.groups.find((entry) => entry.id === group.id)

	async function dissolve() {
		if (!detail) return
		try {
			await request(`/groups/${encodeURIComponent(detail.id)}/dissolve`, {
				method: 'POST',
				body: JSON.stringify({ expectedVersion: detail.version }),
			})
			toast.success(t`Group removed. Its products are separate again.`)
			notifyChanged()
			onChanged()
			close()
		} catch (caught) {
			toast.error(i18n._(inventorySaveErrorMessage(caught)))
		}
	}

	return (
		<SheetPanel
			title={<span className="wrap-anywhere">{group.name}</span>}
			description={<Trans>Ingredient group</Trans>}
			headerExtra={
				<Badge variant="secondary">
					<Trans>Group</Trans>
				</Badge>
			}
		>
			{groups.loading && !detail ? (
				<Skeleton className="h-24 w-full rounded-xl" />
			) : groups.error && !detail ? (
				<Alert variant="destructive">
					<AlertDescription>
						{i18n._(inventoryErrorMessage(groups.error))}
					</AlertDescription>
				</Alert>
			) : detail ? (
				<>
					{canEdit ? (
						<div className="flex flex-wrap gap-2">
							<Button
								variant="outline"
								onClick={() => setEditing(true)}
								data-testid="group-edit"
							>
								<Icon name="pencil" />
								<Trans>Edit group</Trans>
							</Button>
							<Button
								variant="outline"
								onClick={() => void dissolve()}
								data-testid="group-dissolve"
							>
								<Trans>Ungroup</Trans>
							</Button>
						</div>
					) : null}
					<section className="flex flex-col gap-3" data-testid="group-total">
						<span className="text-muted-foreground text-xs">
							<Trans>On hand across the group</Trans>
						</span>
						<bdi dir="ltr" className="text-2xl font-semibold tabular-nums">
							{quantity.format(detail.onHand, { baseUnit: detail.baseUnit })}
						</bdi>
						{canSeeCost && detail.costMicro !== undefined ? (
							<p className="text-muted-foreground text-xs">
								<Trans>Costed at the first product's price.</Trans>
							</p>
						) : null}
					</section>
					<ul
						className="flex flex-col divide-y rounded-xl border"
						data-testid="group-member-list"
					>
						{detail.members.map((member) => (
							<li
								key={member.itemId}
								className="flex items-baseline justify-between gap-3 p-3 text-sm"
								data-testid={`group-member-row-${member.itemId}`}
							>
								<span className="min-w-0 wrap-anywhere">
									<Link
										className="font-medium underline-offset-2 hover:underline"
										to={`${basePath}/${member.itemId}${search}`}
									>
										{member.name}
									</Link>
									{member.rank === 0 ? (
										<span className="text-muted-foreground">
											{' · '}
											<Trans>used first</Trans>
										</span>
									) : null}
								</span>
								<span className="shrink-0 text-end tabular-nums">
									<bdi dir="ltr">
										{quantity.format(member.onHand, {
											baseUnit: member.baseUnit,
										})}
									</bdi>
									{canSeeCost &&
									member.costMicro !== undefined &&
									member.costMicro !== null ? (
										<span className="text-muted-foreground block text-xs">
											<bdi dir="ltr">
												{formatMoney(
													Math.round(member.costMicro / 1_000_000),
													member.currency ?? currency,
													i18n.locale,
												)}
											</bdi>
										</span>
									) : null}
								</span>
							</li>
						))}
					</ul>
					{recipesEnabled && used.data && used.data.rows.length > 0 ? (
						<section className="flex flex-col gap-3">
							<h3 className="text-sm font-semibold">
								<Trans>Used in</Trans>
							</h3>
							<UsedInList
								result={used.data}
								names={names}
								orgSlug={orgSlug}
								canSeeCost={canSeeCost}
								currency={currency}
							/>
						</section>
					) : null}
					<GroupDialog
						group={detail}
						locationId={locationId}
						open={editing}
						onOpenChange={setEditing}
						onSaved={() => {
							groups.reload()
							onChanged()
						}}
					/>
				</>
			) : null}
		</SheetPanel>
	)
}
