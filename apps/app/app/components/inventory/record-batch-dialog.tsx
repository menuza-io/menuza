import { Trans, useLingui } from '@lingui/react/macro'
import { type ItemDetail, recordBatchResultSchema } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Field, FieldError, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { QuantityStepper } from '@repo/ui/quantity-stepper'
import { Textarea } from '@repo/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import {
	batchProblems,
	buildBatch,
	type BatchDraft,
	emptyBatchDraft,
} from '#app/utils/inventory/batch-form.ts'
import { entryStep, unitChoices } from '#app/utils/inventory/format.ts'
import { batchSaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { recipeEntryUnit } from '#app/utils/inventory/recipe-form.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'

/**
 * Record a batch of a made item: how many batches of its recipe were made, or
 * the amount that came out. The region adds the made item to stock and takes
 * its ingredients out as one write; a retry replays the same `clientId`.
 */
export function RecordBatchDialog({
	item,
	locationId,
	open,
	onOpenChange,
	onRecorded,
}: {
	item: Pick<ItemDetail, 'id' | 'name' | 'baseUnit' | 'units' | 'countUnit'>
	locationId: string
	open: boolean
	onOpenChange: (open: boolean) => void
	onRecorded: () => void
}) {
	const [submitting, setSubmitting] = useState(false)
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!submitting) onOpenChange(next)
			}}
		>
			<DialogContent
				className="max-h-dvh overflow-y-auto sm:max-w-md"
				data-testid="record-batch-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Record a batch</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Adds what you made to stock and takes the ingredients out.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<BatchForm
					item={item}
					locationId={locationId}
					submitting={submitting}
					onSubmittingChange={setSubmitting}
					onClose={() => onOpenChange(false)}
					onRecorded={onRecorded}
				/>
			</DialogContent>
		</Dialog>
	)
}

function BatchForm({
	item,
	locationId,
	submitting,
	onSubmittingChange,
	onClose,
	onRecorded,
}: {
	item: Pick<ItemDetail, 'id' | 'name' | 'baseUnit' | 'units' | 'countUnit'>
	locationId: string
	submitting: boolean
	onSubmittingChange: (submitting: boolean) => void
	onClose: () => void
	onRecorded: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const countId = useId()
	const amountId = useId()
	const noteId = useId()
	const [draft, setDraft] = useState<BatchDraft>(() => ({
		...emptyBatchDraft(),
		unit: item.countUnit ?? recipeEntryUnit(item.baseUnit, quantity.system),
	}))
	const [attempted, setAttempted] = useState(false)
	const [error, setError] = useState<string | null>(null)
	// One key per batch: a retry after a lost answer replays it.
	const clientIdRef = useRef(newClientId('b'))
	const problems = attempted ? batchProblems(draft) : []
	const units = unitChoices(item.baseUnit, item.units, quantity.system)
	const itemName = item.name

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (submitting) return
		setAttempted(true)
		const body = buildBatch(draft, {
			clientId: clientIdRef.current,
			locationId,
		})
		if (!body) return
		onSubmittingChange(true)
		setError(null)
		try {
			const result = recordBatchResultSchema.parse(
				await request(`/items/${encodeURIComponent(item.id)}/batch`, {
					method: 'POST',
					body: JSON.stringify(body),
				}),
			)
			clientIdRef.current = newClientId('b')
			const added = quantity.format(result.madeQuantity, {
				baseUnit: item.baseUnit,
				countUnit: item.countUnit,
				units: item.units,
			})
			toast.success(t`Batch recorded: ${added} of ${itemName} added.`)
			notifyChanged()
			onRecorded()
			onClose()
		} catch (caught) {
			setError(i18n._(batchSaveErrorMessage(caught)))
		} finally {
			onSubmittingChange(false)
		}
	}

	return (
		<form
			onSubmit={(event) => void submit(event)}
			noValidate
			className="flex flex-col gap-4"
			data-testid="record-batch-form"
		>
			{error ? (
				<Alert variant="destructive" data-testid="record-batch-error">
					<Icon name="alert-triangle" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			<ToggleGroup
				aria-label={t`What to record`}
				variant="outline"
				value={[draft.kind]}
				disabled={submitting}
				onValueChange={(next) => {
					if (next[0] === 'batches' || next[0] === 'amount') {
						setDraft({ ...draft, kind: next[0] })
					}
				}}
				className="flex-wrap"
			>
				<ToggleGroupItem
					value="batches"
					className="h-11 md:h-8"
					data-testid="record-batch-kind-batches"
				>
					<Trans>Number of batches</Trans>
				</ToggleGroupItem>
				<ToggleGroupItem
					value="amount"
					className="h-11 md:h-8"
					data-testid="record-batch-kind-amount"
				>
					<Trans>Amount that came out</Trans>
				</ToggleGroupItem>
			</ToggleGroup>

			{draft.kind === 'batches' ? (
				<Field data-invalid={problems.includes('count') ? true : undefined}>
					<FieldLabel htmlFor={countId}>
						<Trans>How many batches</Trans>
					</FieldLabel>
					<QuantityStepper
						id={countId}
						value={draft.count}
						onValueChange={(count) => setDraft({ ...draft, count })}
						step={1}
						min={0}
						max={1000}
						fractions
						decrementLabel={t`Less`}
						incrementLabel={t`More`}
						fractionLabel={(fraction) => t`Add ${fraction}`}
						disabled={submitting}
						invalid={problems.includes('count')}
						data-testid="record-batch-count"
					/>
					{problems.includes('count') ? (
						<FieldError>
							<Trans>Enter a number of batches above zero.</Trans>
						</FieldError>
					) : null}
				</Field>
			) : (
				<Field data-invalid={problems.includes('amount') ? true : undefined}>
					<FieldLabel htmlFor={amountId}>
						<Trans>Amount</Trans>
					</FieldLabel>
					<div className="flex flex-wrap items-start gap-3">
						<QuantityStepper
							id={amountId}
							value={draft.amount}
							onValueChange={(amount) => setDraft({ ...draft, amount })}
							step={entryStep(draft.unit)}
							decrementLabel={t`Less`}
							incrementLabel={t`More`}
							disabled={submitting}
							invalid={problems.includes('amount')}
							data-testid="record-batch-amount"
						/>
						<ToggleGroup
							aria-label={t`Unit`}
							variant="segmented"
							value={draft.unit ? [draft.unit] : []}
							disabled={submitting}
							onValueChange={(next) => {
								if (next[0]) setDraft({ ...draft, unit: next[0] })
							}}
							className="flex-wrap"
						>
							{units.map((choice) => (
								<ToggleGroupItem
									key={choice}
									value={choice}
									className="h-11 min-w-11 md:h-7"
									data-testid={`record-batch-unit-${choice}`}
								>
									<bdi dir="ltr">{quantity.unitName(choice, item.units)}</bdi>
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</div>
					{problems.includes('amount') ? (
						<FieldError>
							<Trans>Enter an amount above zero.</Trans>
						</FieldError>
					) : null}
				</Field>
			)}

			<Field>
				<FieldLabel htmlFor={noteId}>
					<Trans>Note</Trans>{' '}
					<span className="text-muted-foreground font-normal">
						<Trans>(optional)</Trans>
					</span>
				</FieldLabel>
				<Textarea
					id={noteId}
					value={draft.note}
					onChange={(event) => setDraft({ ...draft, note: event.target.value })}
					rows={2}
					maxLength={500}
					disabled={submitting}
					data-testid="record-batch-note"
				/>
			</Field>

			<DialogFooter>
				<Button
					type="button"
					variant="outline"
					onClick={onClose}
					disabled={submitting}
				>
					<Trans>Cancel</Trans>
				</Button>
				<Button
					type="submit"
					disabled={submitting}
					data-testid="record-batch-submit"
				>
					{submitting ? <Trans>Saving…</Trans> : <Trans>Record batch</Trans>}
				</Button>
			</DialogFooter>
		</form>
	)
}
