import { Trans, useLingui } from '@lingui/react/macro'
import {
	ADJUSTMENT_REASONS,
	type AdjustmentReason,
	type ItemDetail,
	type UnitRef,
} from '@repo/inventory'
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
	type AdjustDirection,
	type AdjustDraft,
	adjustDraftProblems,
	buildAdjustPayload,
} from '#app/utils/inventory/adjust-form.ts'
import {
	defaultEntryUnit,
	entryStep,
	unitChoices,
} from '#app/utils/inventory/format.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { ADJUSTMENT_REASON_LABELS } from '#app/utils/inventory/labels.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'

/**
 * Adjust stock by hand: add or take away an amount, with a reason that goes
 * in the item's history. Counting the whole shelf is a Count; this is for a
 * single correction.
 */
export function AdjustStockDialog({
	item,
	locationId,
	open,
	onOpenChange,
	onAdjusted,
}: {
	item: ItemDetail
	locationId: string
	open: boolean
	onOpenChange: (open: boolean) => void
	onAdjusted: () => void
}) {
	const [submitting, setSubmitting] = useState(false)
	const itemName = item.name
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!submitting) onOpenChange(next)
			}}
		>
			<DialogContent
				className="max-h-dvh overflow-y-auto sm:max-w-md"
				data-testid="adjust-stock-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Adjust stock</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Change how much of{' '}
							<span className="wrap-anywhere">{itemName}</span> you have. The
							reason is kept in its history.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<AdjustForm
					item={item}
					locationId={locationId}
					submitting={submitting}
					onSubmittingChange={setSubmitting}
					onCancel={() => onOpenChange(false)}
					onAdjusted={onAdjusted}
				/>
			</DialogContent>
		</Dialog>
	)
}

function AdjustForm({
	item,
	locationId,
	submitting,
	onSubmittingChange,
	onCancel,
	onAdjusted,
}: {
	item: ItemDetail
	locationId: string
	submitting: boolean
	onSubmittingChange: (submitting: boolean) => void
	onCancel: () => void
	onAdjusted: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const amountId = useId()
	const reasonId = useId()
	const noteId = useId()

	const [direction, setDirection] = useState<AdjustDirection>('add')
	const [amount, setAmount] = useState<number | null>(null)
	const [unit, setUnit] = useState<UnitRef | null>(
		defaultEntryUnit(
			item.baseUnit,
			item.countUnit,
			item.units,
			quantity.system,
		),
	)
	const [reason, setReason] = useState<AdjustmentReason | null>(null)
	const [note, setNote] = useState('')
	const [attempted, setAttempted] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const clientIdRef = useRef(newClientId('a'))

	const draft: AdjustDraft = {
		direction,
		amountText: amount === null ? '' : String(amount),
		unit,
		reason,
		note,
	}
	const problems = attempted ? adjustDraftProblems(draft) : []
	const choices = unitChoices(item.baseUnit, item.units, quantity.system)

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (submitting) return
		setAttempted(true)
		const payload = buildAdjustPayload(draft, {
			clientId: clientIdRef.current,
			locationId,
			baseUnit: item.baseUnit,
			units: item.units,
		})
		if (!payload) return
		onSubmittingChange(true)
		setError(null)
		try {
			await request(`/items/${encodeURIComponent(item.id)}/adjust`, {
				method: 'POST',
				body: JSON.stringify(payload),
			})
			clientIdRef.current = newClientId('a')
			toast.success(t`Stock adjusted.`)
			notifyChanged()
			onAdjusted()
			onCancel()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			onSubmittingChange(false)
		}
	}

	return (
		<form
			onSubmit={(event) => void submit(event)}
			noValidate
			className="flex flex-col gap-4"
			data-testid="adjust-stock-form"
		>
			{error ? (
				<Alert variant="destructive" data-testid="adjust-stock-error">
					<Icon name="alert-triangle" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			<ToggleGroup
				aria-label={t`Add or take away`}
				variant="segmented"
				value={[direction]}
				disabled={submitting}
				onValueChange={(next) => {
					if (next[0]) setDirection(next[0] as AdjustDirection)
				}}
			>
				<ToggleGroupItem
					value="add"
					className="h-11 md:h-7"
					data-testid="adjust-stock-add"
				>
					<Trans>Add stock</Trans>
				</ToggleGroupItem>
				<ToggleGroupItem
					value="remove"
					className="h-11 md:h-7"
					data-testid="adjust-stock-remove"
				>
					<Trans>Take away</Trans>
				</ToggleGroupItem>
			</ToggleGroup>

			<Field data-invalid={problems.includes('amount') ? true : undefined}>
				<FieldLabel htmlFor={amountId}>
					<Trans>Amount</Trans>
				</FieldLabel>
				<div className="flex flex-wrap items-start gap-3">
					<QuantityStepper
						id={amountId}
						value={amount}
						onValueChange={setAmount}
						step={entryStep(unit)}
						decrementLabel={t`Less`}
						incrementLabel={t`More`}
						disabled={submitting}
						invalid={problems.includes('amount')}
						data-testid="adjust-stock-amount"
					/>
					<ToggleGroup
						aria-label={t`Unit`}
						variant="segmented"
						value={unit ? [unit] : []}
						disabled={submitting}
						onValueChange={(next) => {
							if (next[0]) setUnit(next[0])
						}}
						className="flex-wrap"
					>
						{choices.map((choice) => (
							<ToggleGroupItem
								key={choice}
								value={choice}
								className="h-11 min-w-11 md:h-7"
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

			<Field data-invalid={problems.includes('reason') ? true : undefined}>
				<FieldLabel id={reasonId}>
					<Trans>Reason</Trans>
				</FieldLabel>
				<ToggleGroup
					aria-labelledby={reasonId}
					variant="outline"
					spacing={1}
					value={reason ? [reason] : []}
					disabled={submitting}
					onValueChange={(next) =>
						setReason((next[0] as AdjustmentReason | undefined) ?? null)
					}
					className="flex-wrap"
				>
					{ADJUSTMENT_REASONS.map((value) => (
						<ToggleGroupItem
							key={value}
							value={value}
							className="h-11 md:h-8"
							data-testid={`adjust-stock-reason-${value}`}
						>
							{i18n._(ADJUSTMENT_REASON_LABELS[value])}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				{problems.includes('reason') ? (
					<FieldError>
						<Trans>Choose a reason.</Trans>
					</FieldError>
				) : null}
			</Field>

			<Field>
				<FieldLabel htmlFor={noteId}>
					<Trans>Note</Trans>{' '}
					<span className="text-muted-foreground font-normal">
						<Trans>(optional)</Trans>
					</span>
				</FieldLabel>
				<Textarea
					id={noteId}
					value={note}
					onChange={(event) => setNote(event.target.value)}
					rows={2}
					maxLength={500}
					disabled={submitting}
				/>
			</Field>

			<DialogFooter>
				<Button
					type="button"
					variant="outline"
					onClick={onCancel}
					disabled={submitting}
				>
					<Trans>Cancel</Trans>
				</Button>
				<Button
					type="submit"
					disabled={submitting}
					data-testid="adjust-stock-submit"
				>
					{submitting ? <Trans>Saving…</Trans> : <Trans>Save adjustment</Trans>}
				</Button>
			</DialogFooter>
		</form>
	)
}
