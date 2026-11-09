import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { soldOutListSchema, type SoldOutEntry } from '@repo/inventory'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useState } from 'react'
import { toast } from 'sonner'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { isRecipesUnavailable } from '#app/utils/inventory/inventory-errors.ts'

type Named = { id: string; name: string }

/**
 * "Off the menu by stock": the dishes and options the region took off because
 * an ingredient ran out (auto sold out), with a manager's undo for each one
 * while stock is still at zero. The region answers with ids; the names are
 * joined from the menu the Today loader sends. Hidden when nothing is off.
 */
export function SoldOutPanel({
	locationId,
	canEdit,
	dishes,
	options,
}: {
	locationId: string
	canEdit: boolean
	dishes: readonly Named[]
	options: readonly Named[]
}) {
	const { t } = useLingui()
	const { request } = useInventoryClient()
	const list = useInventoryQuery(
		`/sold-out?${new URLSearchParams({ locationId })}`,
		soldOutListSchema,
	)
	const [busy, setBusy] = useState<string | null>(null)
	if (list.error && isRecipesUnavailable(list.error)) return null
	if (list.loading && !list.data) {
		return <Skeleton className="h-16 w-full rounded-xl" />
	}
	const entries = (list.data?.entries ?? []).filter(
		(entry) => entry.state === 'out',
	)
	if (entries.length === 0) return null

	const dishName = new Map(dishes.map((dish) => [dish.id, dish.name]))
	const optionName = new Map(options.map((option) => [option.id, option.name]))
	const nameOf = (entry: SoldOutEntry) =>
		(entry.entityType === 'item' ? dishName : optionName).get(entry.entityId) ??
		null

	async function undo(entry: SoldOutEntry) {
		setBusy(entry.id)
		try {
			await request(`/sold-out/${encodeURIComponent(entry.id)}/undo`, {
				method: 'POST',
				body: JSON.stringify({}),
			})
			toast.success(t`Put back on the menu.`)
			list.reload()
		} catch {
			toast.error(t`We could not put it back. Try again in a moment.`)
		} finally {
			setBusy(null)
		}
	}

	return (
		<div id="sold-out" className="scroll-mt-20">
			<WorkspacePanel
				title={<Trans>Off the menu by stock</Trans>}
				data-testid="today-sold-out"
			>
				<div className="flex flex-col gap-3">
					<p className="text-muted-foreground text-sm">
						<Trans>
							These come back by themselves when the ingredient is delivered or
							counted again.
						</Trans>
					</p>
					<ul
						className="flex flex-col divide-y rounded-xl border"
						data-testid="today-sold-out-list"
					>
						{entries.map((entry) => {
							const name = nameOf(entry)
							const cause = entry.causeItemName
							return (
								<li
									key={entry.id}
									className="flex flex-wrap items-center justify-between gap-3 p-3"
									data-testid={`today-sold-out-${entry.entityId}`}
								>
									<span className="flex min-w-0 flex-col gap-0.5">
										<span className="flex flex-wrap items-center gap-2 text-sm font-medium wrap-anywhere">
											{name ?? (
												<Trans>A dish that is no longer on the menu</Trans>
											)}
											{entry.entityType === 'modifier_option' ? (
												<Badge variant="outline">
													<Trans>Option</Trans>
												</Badge>
											) : null}
										</span>
										<span className="text-muted-foreground text-xs">
											<Trans>
												<span className="wrap-anywhere">{cause}</span> ran out
											</Trans>
										</span>
									</span>
									{canEdit ? (
										<Button
											variant="outline"
											size="sm"
											disabled={busy !== null}
											onClick={() => void undo(entry)}
											data-testid={`today-sold-out-undo-${entry.entityId}`}
										>
											<Trans>Put back</Trans>
										</Button>
									) : null}
								</li>
							)
						})}
					</ul>
					<p className="text-muted-foreground text-xs">
						<Plural
							value={entries.length}
							one="# dish or option is off the menu."
							other="# dishes and options are off the menu."
						/>
					</p>
				</div>
			</WorkspacePanel>
		</div>
	)
}
