import { Trans, useLingui } from '@lingui/react/macro'
import { type WasteEntry, wasteEntrySchema } from '@repo/inventory'
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
	defaultEntryUnit,
	entryStep,
	unitChoices,
} from '#app/utils/inventory/format.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'

/**
 * Correct or reverse a waste entry later, with a reason (#522). The original
 * row stays and a correction is added, so the log shows both. Unless an
 * approved count already covers the entry, stock moves by the difference; when
 * one does, only the waste figures are corrected and this dialog says so
 * before anything is asked. A dish is corrected by its number of dishes.
 */
export function CorrectWasteDialog({
	entry,
	name,
	open,
	onOpenChange,
	onCorrected,
}: {
	entry: WasteEntry | null
	/** What the entry is called in the log ("Chicken", "2 x Shawarma"). */
	name: string
	open: boolean
	onOpenChange: (open: boolean) => void
	onCorrected: () => void
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
				data-testid="correct-waste-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Correct this waste</Trans>
					</DialogTitle>
					<DialogDescription>
						<span className="wrap-anywhere">{name}</span>
					</DialogDescription>
				</DialogHeader>
				{entry ? (
					<CorrectWasteForm
						key={entry.id}
						entry={entry}
						submitting={submitting}
						onSubmittingChange={setSubmitting}
						onClose={() => onOpenChange(false)}
						onCorrected={onCorrected}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	)
}

function CorrectWasteForm({
	entry,
	submitting,
	onSubmittingChange,
	onClose,
	onCorrected,
}: {
	entry: WasteEntry
	submitting: boolean
	onSubmittingChange: (submitting: boolean) => void
	onClose: () => void
	onCorrected: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const reasonId = useId()
	const isDish = entry.dish !== undefined
	const baseUnit = entry.baseUnit
	const currentDishes = entry.currentQuantity ?? entry.dish?.dishes ?? 1
	const [kind, setKind] = useState<'reverse' | 'quantity'>('reverse')
	const [amount, setAmount] = useState<number | null>(
		isDish ? currentDishes : null,
	)
	const [unit, setUnit] = useState(
		baseUnit ? defaultEntryUnit(baseUnit, null, [], quantity.system) : 'g',
	)
	const [reason, setReason] = useState('')
	const [attempted, setAttempted] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const clientIdRef = useRef(newClientId('c'))
	const units = baseUnit ? unitChoices(baseUnit, [], quantity.system) : []
	const covered = entry.countedSince === true
	const reasonTooShort = reason.trim().length < 3
	const amountMissing = kind === 'quantity' && !(amount && amount > 0)

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (submitting) return
		setAttempted(true)
		if (reasonTooShort || amountMissing) return
		onSubmittingChange(true)
		setError(null)
		try {
			wasteEntrySchema.parse(
				await request(`/waste/${encodeURIComponent(entry.id)}/correct`, {
					method: 'POST',
					body: JSON.stringify({
						clientId: clientIdRef.current,
						kind,
						...(kind === 'quantity'
							? isDish
								? { dishes: amount }
								: { amount, unit }
							: {}),
						reason: reason.trim(),
					}),
				}),
			)
			clientIdRef.current = newClientId('c')
			toast.success(
				kind === 'reverse' ? t`Waste reversed.` : t`Waste corrected.`,
			)
			notifyChanged()
			onCorrected()
			onClose()
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
			data-testid="correct-waste-form"
		>
			{error ? (
				<Alert variant="destructive" data-testid="correct-waste-error">
					<Icon name="alert-triangle" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			{covered ? (
				<Alert data-testid="correct-waste-covered-note">
					<AlertDescription>
						<Trans>
							A count taken after this was logged already reflects it, so your
							stock will not change. Only the waste figures are corrected.
						</Trans>
					</AlertDescription>
				</Alert>
			) : (
				<p
					className="text-muted-foreground text-sm"
					data-testid="correct-waste-stock-note"
				>
					<Trans>
						Your stock changes by the difference. The original entry stays on
						the log.
					</Trans>
				</p>
			)}

			<ToggleGroup
				aria-label={t`What to do`}
				variant="segmented"
				value={[kind]}
				disabled={submitting}
				onValueChange={(next) => {
					if (next[0]) setKind(next[0] as 'reverse' | 'quantity')
				}}
			>
				<ToggleGroupItem
					value="reverse"
					className="h-11 md:h-7"
					data-testid="correct-waste-kind-reverse"
				>
					<Trans>Reverse it</Trans>
				</ToggleGroupItem>
				<ToggleGroupItem
					value="quantity"
					className="h-11 md:h-7"
					data-testid="correct-waste-kind-quantity"
				>
					<Trans>Change the amount</Trans>
				</ToggleGroupItem>
			</ToggleGroup>

			{kind === 'quantity' ? (
				<Field data-invalid={attempted && amountMissing ? true : undefined}>
					<FieldLabel>
						{isDish ? (
							<Trans>How many dishes?</Trans>
						) : (
							<Trans>New amount</Trans>
						)}
					</FieldLabel>
					<div className="flex flex-wrap items-start gap-3">
						<QuantityStepper
							value={amount}
							onValueChange={setAmount}
							step={isDish ? 1 : entryStep(unit)}
							min={isDish ? 1 : 0}
							decrementLabel={t`Less`}
							incrementLabel={t`More`}
							disabled={submitting}
							invalid={attempted && amountMissing}
							data-testid="correct-waste-amount"
						/>
						{!isDish && baseUnit ? (
							<ToggleGroup
								aria-label={t`Unit`}
								variant="segmented"
								value={[unit]}
								disabled={submitting}
								onValueChange={(next) => {
									if (next[0]) setUnit(next[0])
								}}
								className="flex-wrap"
							>
								{units.map((choice) => (
									<ToggleGroupItem
										key={choice}
										value={choice}
										className="h-11 min-w-11 md:h-7"
									>
										<bdi dir="ltr">{quantity.unitName(choice, [])}</bdi>
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						) : null}
					</div>
					{attempted && amountMissing ? (
						<FieldError>
							<Trans>Enter an amount above zero.</Trans>
						</FieldError>
					) : null}
				</Field>
			) : null}

			<Field data-invalid={attempted && reasonTooShort ? true : undefined}>
				<FieldLabel htmlFor={reasonId}>
					<Trans>Why is it being corrected?</Trans>
				</FieldLabel>
				<Textarea
					id={reasonId}
					value={reason}
					onChange={(event) => setReason(event.target.value)}
					rows={2}
					maxLength={300}
					disabled={submitting}
					data-testid="correct-waste-reason"
				/>
				{attempted && reasonTooShort ? (
					<FieldError>
						<Trans>Say why, in a few words.</Trans>
					</FieldError>
				) : null}
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
					data-testid="correct-waste-submit"
				>
					{submitting ? (
						<Trans>Saving…</Trans>
					) : kind === 'reverse' ? (
						<Trans>Reverse waste</Trans>
					) : (
						<Trans>Save correction</Trans>
					)}
				</Button>
			</DialogFooter>
		</form>
	)
}
