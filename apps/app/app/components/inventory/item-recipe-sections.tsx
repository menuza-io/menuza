import { Trans, useLingui } from '@lingui/react/macro'
import { type ItemDetail } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { useId, useState } from 'react'
import { RecipeSection } from '#app/components/inventory/recipe-section.tsx'
import { RecordBatchDialog } from '#app/components/inventory/record-batch-dialog.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'

/**
 * The recipe pieces of the Stock item sheet, all behind the `inventory.recipes`
 * flag (the sheet passes it from the layout): for an item made in house its
 * recipe, the "we make this in batches" switch and Record a batch; for any item
 * the "mark dishes sold out" switch. Each control saves by itself.
 */
export function ItemRecipeSections({
	item,
	locationId,
	currency,
	recipesEnabled,
	canEditRecipes,
	canEditInventory,
	onChanged,
}: {
	item: ItemDetail
	locationId: string
	currency: string
	recipesEnabled: boolean
	/** `update:inventory_recipe:any`. */
	canEditRecipes: boolean
	/** `update:inventory:any` (and not archived). */
	canEditInventory: boolean
	onChanged: () => void
}) {
	const { i18n } = useLingui()
	const { request } = useInventoryClient()
	const [hidden, setHidden] = useState(false)
	const [recording, setRecording] = useState(false)
	const [pending, setPending] = useState<'batchCounted' | 'autoSoldOut' | null>(
		null,
	)
	const [error, setError] = useState<string | null>(null)
	const batchId = useId()
	const soldOutId = useId()

	if (!recipesEnabled || hidden) return null
	const isMade = item.kind === 'made'

	async function patch(field: 'batchCounted' | 'autoSoldOut', value: boolean) {
		setPending(field)
		setError(null)
		try {
			await request(`/items/${encodeURIComponent(item.id)}`, {
				method: 'PATCH',
				body: JSON.stringify({ expectedVersion: item.version, [field]: value }),
			})
			onChanged()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setPending(null)
		}
	}

	return (
		<>
			{isMade ? (
				<section
					className="flex flex-col gap-3"
					aria-labelledby="item-recipe"
					data-testid="item-sheet-recipe"
				>
					<h3 id="item-recipe" className="text-sm font-semibold">
						<Trans>Recipe</Trans>
					</h3>
					<RecipeSection
						ownerKind="made_item"
						ownerId={item.id}
						idPrefix="made-recipe"
						canEdit={canEditRecipes}
						canTypeCost={false}
						locationId={locationId}
						currency={currency}
						showSummary
						madeItem={{
							id: item.id,
							name: item.name,
							baseUnit: item.baseUnit,
							units: item.units,
						}}
						onHidden={() => setHidden(true)}
						onSaved={onChanged}
						bare
						intro={
							<Trans>
								What goes into one batch, and how much one batch makes.
							</Trans>
						}
					/>
				</section>
			) : null}

			<section
				className="flex flex-col gap-3"
				aria-labelledby="item-sales-use"
				data-testid="item-sheet-sales-use"
			>
				<h3 id="item-sales-use" className="text-sm font-semibold">
					<Trans>Used by sales</Trans>
				</h3>
				{error ? (
					<Alert variant="destructive" data-testid="item-sheet-recipe-error">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				{isMade ? (
					<div className="flex flex-col gap-3">
						<div className="flex items-start justify-between gap-4">
							<Label
								htmlFor={batchId}
								className="block min-w-0 cursor-pointer space-y-0.5 font-normal"
							>
								<span className="text-foreground block text-sm">
									<Trans>We make this in batches and count it</Trans>
								</span>
								<span className="text-muted-foreground block text-xs">
									<Trans>
										Off: sales use its ingredients directly. On: sales use this
										item, and you record each batch you make.
									</Trans>
								</span>
							</Label>
							<Switch
								id={batchId}
								checked={item.batchCounted ?? false}
								disabled={!canEditInventory || pending !== null}
								onCheckedChange={(next) => void patch('batchCounted', next)}
								data-testid="item-sheet-batch-counted"
							/>
						</div>
						{canEditInventory ? (
							<Button
								type="button"
								variant="outline"
								className="self-start"
								onClick={() => setRecording(true)}
								data-testid="item-sheet-record-batch"
							>
								<Trans>Record a batch</Trans>
							</Button>
						) : null}
					</div>
				) : null}
				<div className="flex items-start justify-between gap-4">
					<Label
						htmlFor={soldOutId}
						className="block min-w-0 cursor-pointer space-y-0.5 font-normal"
					>
						<span className="text-foreground block text-sm">
							<Trans>Mark dishes sold out when this runs out</Trans>
						</span>
						<span className="text-muted-foreground block text-xs">
							<Trans>
								Only works if it was counted in the last 7 days. You can undo it
								from Today.
							</Trans>
						</span>
					</Label>
					<Switch
						id={soldOutId}
						checked={item.autoSoldOut ?? false}
						disabled={!canEditRecipes || pending !== null}
						onCheckedChange={(next) => void patch('autoSoldOut', next)}
						data-testid="item-sheet-auto-sold-out"
					/>
				</div>
			</section>

			{isMade && canEditInventory ? (
				<RecordBatchDialog
					item={item}
					locationId={locationId}
					open={recording}
					onOpenChange={setRecording}
					onRecorded={onChanged}
				/>
			) : null}
		</>
	)
}
