import { Trans, useLingui } from '@lingui/react/macro'
import {
	bottleSpecProblem,
	type ItemDetail,
	MAX_BOTTLE_SIZE_ML,
	MAX_BOTTLE_WEIGHT_G,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useId, useState } from 'react'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'

/** A whole number from typed text, or `null` when blank or not a number. */
function wholeNumber(text: string): number | null {
	const trimmed = text.trim()
	if (trimmed === '') return null
	const value = Number(trimmed.replace(',', '.'))
	return Number.isFinite(value) ? Math.round(value) : null
}

/**
 * How an item is counted (#490, #470): a key item (the star) goes into every
 * quick count; a millilitre item can be counted by bottle, with the full and
 * empty bottle weight so an open bottle can be counted by weight.
 */
export function ItemCountingSection({
	item,
	canEdit,
	onChanged,
}: {
	item: ItemDetail
	canEdit: boolean
	onChanged: () => void
}) {
	const { i18n } = useLingui()
	const { request } = useInventoryClient()
	const keyId = useId()
	const bottleId = useId()
	const sizeId = useId()
	const fullId = useId()
	const emptyId = useId()
	const [byBottle, setByBottle] = useState(item.bottle != null)
	const [size, setSize] = useState(String(item.bottle?.sizeMl ?? ''))
	const [full, setFull] = useState(String(item.bottle?.fullWeightG ?? ''))
	const [empty, setEmpty] = useState(String(item.bottle?.emptyWeightG ?? ''))
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function patch(body: Record<string, unknown>) {
		setBusy(true)
		setError(null)
		try {
			await request(`/items/${encodeURIComponent(item.id)}`, {
				method: 'PATCH',
				body: JSON.stringify({ expectedVersion: item.version, ...body }),
			})
			onChanged()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setBusy(false)
		}
	}

	const sizeMl = wholeNumber(size)
	const fullWeightG = wholeNumber(full)
	const emptyWeightG = wholeNumber(empty)
	const problem = byBottle
		? bottleSpecProblem({ sizeMl, fullWeightG, emptyWeightG })
		: null

	return (
		<section
			className="flex flex-col gap-3"
			aria-labelledby="item-counting"
			data-testid="item-counting"
		>
			<h3 id="item-counting" className="text-sm font-semibold">
				<Trans>Counting</Trans>
			</h3>
			{error ? (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<div className="flex items-start gap-2.5">
				<Checkbox
					id={keyId}
					checked={item.isKey === true}
					disabled={!canEdit || busy}
					onCheckedChange={(checked) => void patch({ isKey: Boolean(checked) })}
					data-testid="item-key"
				/>
				<div className="flex flex-col gap-0.5">
					<Label htmlFor={keyId} className="font-normal">
						<Trans>Key item</Trans>
					</Label>
					<p className="text-muted-foreground text-xs">
						<Trans>
							Expensive or easy-to-lose items. They are in every quick count,
							and you can filter Stock to them.
						</Trans>
					</p>
				</div>
			</div>

			{item.baseUnit === 'ml' ? (
				<div className="flex flex-col gap-3">
					<div className="flex items-start gap-2.5">
						<Checkbox
							id={bottleId}
							checked={byBottle}
							disabled={!canEdit || busy}
							onCheckedChange={(checked) => {
								const on = Boolean(checked)
								setByBottle(on)
								if (!on && item.bottle != null) void patch({ bottle: null })
							}}
							data-testid="item-by-bottle"
						/>
						<div className="flex flex-col gap-0.5">
							<Label htmlFor={bottleId} className="font-normal">
								<Trans>Count by bottle</Trans>
							</Label>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Whole bottles, plus the open bottle in tenths or by its
									weight. The total is kept in millilitres.
								</Trans>
							</p>
						</div>
					</div>
					{byBottle ? (
						<div
							className="grid max-w-lg grid-cols-1 gap-3 sm:grid-cols-3"
							data-testid="item-bottle-fields"
						>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={sizeId}>
									<Trans>Bottle size (ml)</Trans>
								</Label>
								<Input
									id={sizeId}
									inputMode="numeric"
									dir="ltr"
									value={size}
									disabled={!canEdit || busy}
									onChange={(event) => setSize(event.target.value)}
									aria-invalid={problem === 'size_required'}
									data-testid="item-bottle-size"
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={fullId}>
									<Trans>Full bottle weight (g)</Trans>
								</Label>
								<Input
									id={fullId}
									inputMode="numeric"
									dir="ltr"
									value={full}
									disabled={!canEdit || busy}
									onChange={(event) => setFull(event.target.value)}
									data-testid="item-bottle-full"
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={emptyId}>
									<Trans>Empty bottle weight (g)</Trans>
								</Label>
								<Input
									id={emptyId}
									inputMode="numeric"
									dir="ltr"
									value={empty}
									disabled={!canEdit || busy}
									onChange={(event) => setEmpty(event.target.value)}
									data-testid="item-bottle-empty"
								/>
							</div>
							<p className="text-muted-foreground text-xs sm:col-span-3">
								<Trans>
									Weights are optional. With both, an open bottle can be counted
									by typing what it weighs on your scale.
								</Trans>
							</p>
							{problem === 'weights_pair' ? (
								<p className="text-destructive text-xs sm:col-span-3">
									<Trans>Enter both weights, or neither.</Trans>
								</p>
							) : problem === 'full_not_heavier' ? (
								<p className="text-destructive text-xs sm:col-span-3">
									<Trans>
										A full bottle must weigh more than an empty one.
									</Trans>
								</p>
							) : null}
							{canEdit ? (
								<div className="sm:col-span-3">
									<Button
										type="button"
										disabled={
											busy ||
											problem !== null ||
											(sizeMl ?? 0) > MAX_BOTTLE_SIZE_ML ||
											(fullWeightG ?? 0) > MAX_BOTTLE_WEIGHT_G
										}
										onClick={() =>
											void patch({
												bottle: { sizeMl, fullWeightG, emptyWeightG },
											})
										}
										data-testid="item-bottle-save"
									>
										<Trans>Save bottle</Trans>
									</Button>
								</div>
							) : null}
						</div>
					) : null}
				</div>
			) : null}
		</section>
	)
}
