import { Trans, useLingui } from '@lingui/react/macro'
import {
	type TransferDetail,
	type TransferKind,
	transferDetailSchema,
	type UnitRef,
	MAX_TRANSFER_LINES,
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
import { ItemPicker } from '#app/components/inventory/item-picker.tsx'
import { SelectField } from '#app/components/staff/controls.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import {
	defaultEntryUnit,
	entryStep,
	thousandthsInUnit,
	unitChoices,
} from '#app/utils/inventory/format.ts'
import {
	buildTransferLines,
	confirmStartQuantity,
	emptyTransferDraft,
	emptyTransferLine,
	type TransferDraft,
	type TransferLineDraft,
	transferErrorMessage,
	transferProblems,
} from '#app/utils/inventory/transfer-form.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'

export type TransferPlace = { id: string; name: string }

/**
 * A new transfer ("send stock to another place") or a request ("ask another
 * place for stock"): the other place, the items with an amount each, and an
 * optional note. A retry after a lost answer replays the same `clientId`.
 */
export function CreateTransferDialog({
	kind,
	locationId,
	places,
	open,
	onOpenChange,
	onCreated,
}: {
	kind: TransferKind
	locationId: string
	places: readonly TransferPlace[]
	open: boolean
	onOpenChange: (open: boolean) => void
	onCreated: () => void
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
				className="max-h-dvh overflow-y-auto sm:max-w-lg"
				data-testid="create-transfer-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						{kind === 'request' ? (
							<Trans>Ask for stock</Trans>
						) : (
							<Trans>Send stock</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						{kind === 'request' ? (
							<Trans>
								Ask another place to send you stock. Nothing moves until they
								send it and you receive it.
							</Trans>
						) : (
							<Trans>
								Plan what you will send. Stock leaves your place when you
								confirm sending, and enters theirs when they receive it.
							</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				<CreateTransferForm
					kind={kind}
					locationId={locationId}
					places={places}
					submitting={submitting}
					onSubmittingChange={setSubmitting}
					onClose={() => onOpenChange(false)}
					onCreated={onCreated}
				/>
			</DialogContent>
		</Dialog>
	)
}

function CreateTransferForm({
	kind,
	locationId,
	places,
	submitting,
	onSubmittingChange,
	onClose,
	onCreated,
}: {
	kind: TransferKind
	locationId: string
	places: readonly TransferPlace[]
	submitting: boolean
	onSubmittingChange: (submitting: boolean) => void
	onClose: () => void
	onCreated: () => void
}) {
	const { t, i18n } = useLingui()
	const client = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const noteId = useId()
	const [draft, setDraft] = useState<TransferDraft>(emptyTransferDraft)
	const [attempted, setAttempted] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const clientIdRef = useRef(newClientId('t'))
	const problems = attempted ? transferProblems(draft) : []
	const others = places.filter((place) => place.id !== locationId)

	function setLine(key: string, next: Partial<TransferLineDraft>) {
		setDraft((current) => ({
			...current,
			lines: current.lines.map((line) =>
				line.key === key ? { ...line, ...next } : line,
			),
		}))
	}

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (submitting) return
		setAttempted(true)
		const lines = buildTransferLines(draft)
		if (!lines) return
		onSubmittingChange(true)
		setError(null)
		try {
			transferDetailSchema.parse(
				await client.request('/transfers', {
					method: 'POST',
					body: JSON.stringify({
						clientId: clientIdRef.current,
						kind,
						fromLocationId:
							kind === 'request' ? draft.otherLocationId : locationId,
						toLocationId:
							kind === 'request' ? locationId : draft.otherLocationId,
						lines,
						...(draft.note.trim() ? { note: draft.note.trim() } : {}),
					}),
				}),
			)
			clientIdRef.current = newClientId('t')
			toast.success(
				kind === 'request' ? t`Request made.` : t`Transfer planned.`,
			)
			notifyChanged()
			onCreated()
			onClose()
		} catch (caught) {
			setError(i18n._(transferErrorMessage(caught)))
		} finally {
			onSubmittingChange(false)
		}
	}

	return (
		<form
			onSubmit={(event) => void submit(event)}
			noValidate
			className="flex flex-col gap-4"
			data-testid="create-transfer-form"
		>
			{error ? (
				<Alert variant="destructive" data-testid="create-transfer-error">
					<Icon name="alert-triangle" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			<SelectField
				label={kind === 'request' ? <Trans>Ask</Trans> : <Trans>Send to</Trans>}
				testId="transfer-place"
				placeholder={t`Choose a place`}
				options={others.map((place) => ({
					value: place.id,
					label: place.name,
				}))}
				value={draft.otherLocationId}
				onValueChange={(otherLocationId) =>
					setDraft({ ...draft, otherLocationId })
				}
				error={problems.includes('place') ? t`Choose a place.` : undefined}
				disabled={submitting}
			/>

			<ul className="flex flex-col gap-3" data-testid="transfer-lines">
				{draft.lines.map((line, index) => (
					<TransferLineRow
						key={line.key}
						line={line}
						index={index}
						locationId={locationId}
						submitting={submitting}
						invalid={
							attempted &&
							(line.item === null || !(line.amount && line.amount > 0)) &&
							!(line.item === null && !line.amount && draft.lines.length > 1)
						}
						onChange={(next) => setLine(line.key, next)}
						onRemove={
							draft.lines.length > 1
								? () =>
										setDraft((current) => ({
											...current,
											lines: current.lines.filter(
												(entry) => entry.key !== line.key,
											),
										}))
								: undefined
						}
					/>
				))}
			</ul>
			{draft.lines.length < MAX_TRANSFER_LINES ? (
				<Button
					type="button"
					variant="outline"
					className="justify-self-start"
					disabled={submitting}
					onClick={() =>
						setDraft((current) => ({
							...current,
							lines: [...current.lines, emptyTransferLine()],
						}))
					}
					data-testid="transfer-add-line"
				>
					<Icon name="plus" />
					<Trans>Add item</Trans>
				</Button>
			) : null}
			{problems.includes('no_lines') ? (
				<FieldError>
					<Trans>Add at least one item with an amount.</Trans>
				</FieldError>
			) : null}
			{problems.includes('duplicate_item') ? (
				<FieldError>
					<Trans>Each item can be on the list once.</Trans>
				</FieldError>
			) : null}

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
					data-testid="transfer-note"
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
					data-testid="create-transfer-submit"
				>
					{submitting ? (
						<Trans>Saving…</Trans>
					) : kind === 'request' ? (
						<Trans>Make request</Trans>
					) : (
						<Trans>Plan transfer</Trans>
					)}
				</Button>
			</DialogFooter>
		</form>
	)
}

function TransferLineRow({
	line,
	index,
	locationId,
	submitting,
	invalid,
	onChange,
	onRemove,
}: {
	line: TransferLineDraft
	index: number
	locationId: string
	submitting: boolean
	invalid: boolean
	onChange: (next: Partial<TransferLineDraft>) => void
	onRemove?: () => void
}) {
	const { t } = useLingui()
	const client = useInventoryClient()
	const quantity = useQuantityFormat()
	const item = line.item
	const position = index + 1
	const units = item
		? unitChoices(item.baseUnit, item.units, quantity.system)
		: []
	return (
		<li
			className="flex flex-col gap-2 rounded-xl border p-3"
			data-testid={`transfer-line-${index}`}
		>
			<ItemPicker
				label={<span className="sr-only">{t`Item ${position}`}</span>}
				client={client}
				locationId={locationId}
				value={item}
				placeholder={t`Choose an item`}
				disabled={submitting}
				testId={`transfer-line-${index}-item`}
				onChange={(picked) =>
					onChange({
						item: picked,
						unit: defaultEntryUnit(
							picked.baseUnit,
							picked.countUnit,
							picked.units,
							quantity.system,
						),
					})
				}
			/>
			{item ? (
				<div className="flex flex-wrap items-start gap-3">
					<QuantityStepper
						value={line.amount}
						onValueChange={(amount) => onChange({ amount })}
						step={entryStep(line.unit)}
						min={0}
						decrementLabel={t`Less`}
						incrementLabel={t`More`}
						disabled={submitting}
						invalid={invalid}
						data-testid={`transfer-line-${index}-amount`}
					/>
					<ToggleGroup
						aria-label={t`Unit`}
						variant="segmented"
						value={line.unit ? [line.unit] : []}
						disabled={submitting}
						onValueChange={(next) => {
							if (next[0]) onChange({ unit: next[0] })
						}}
						className="flex-wrap"
					>
						{units.map((choice) => (
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
			) : null}
			{onRemove ? (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="justify-self-start"
					disabled={submitting}
					onClick={onRemove}
					data-testid={`transfer-line-${index}-remove`}
				>
					<Trans>Remove</Trans>
				</Button>
			) : null}
		</li>
	)
}

/**
 * Confirm what really left (`send`) or what really arrived (`receive`). The
 * amounts start at what was asked for or sent; untouched amounts are not sent
 * at all, so the region uses its own exact figures. Sending less than asked is
 * fine, and what is sent but not received shows on the record as missing.
 */
export function ConfirmTransferDialog({
	step,
	transfer,
	open,
	onOpenChange,
	onDone,
	placeName,
}: {
	step: 'send' | 'receive'
	transfer: TransferDetail | null
	open: boolean
	onOpenChange: (open: boolean) => void
	onDone: () => void
	placeName: (locationId: string) => string
}) {
	const [submitting, setSubmitting] = useState(false)
	const sender = transfer ? placeName(transfer.fromLocationId) : ''
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!submitting) onOpenChange(next)
			}}
		>
			<DialogContent
				className="max-h-dvh overflow-y-auto sm:max-w-lg"
				data-testid="confirm-transfer-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						{step === 'send' ? (
							<Trans>Confirm what you send</Trans>
						) : (
							<Trans>Confirm what arrived</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						{transfer ? (
							step === 'send' ? (
								<Trans>
									Change an amount if you send less. Stock leaves your place
									when you confirm.
								</Trans>
							) : (
								<Trans>
									Change an amount if less arrived from {sender}. Whatever is
									missing is kept on the record.
								</Trans>
							)
						) : null}
					</DialogDescription>
				</DialogHeader>
				{transfer ? (
					<ConfirmTransferForm
						key={`${transfer.id}-${step}`}
						step={step}
						transfer={transfer}
						submitting={submitting}
						onSubmittingChange={setSubmitting}
						onClose={() => onOpenChange(false)}
						onDone={onDone}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	)
}

function ConfirmTransferForm({
	step,
	transfer,
	submitting,
	onSubmittingChange,
	onClose,
	onDone,
}: {
	step: 'send' | 'receive'
	transfer: TransferDetail
	submitting: boolean
	onSubmittingChange: (submitting: boolean) => void
	onClose: () => void
	onDone: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const [error, setError] = useState<string | null>(null)

	const rows = transfer.lines.map((line) => {
		const unit: UnitRef = defaultEntryUnit(
			line.baseUnit,
			line.countUnit,
			line.units,
			quantity.system,
		)
		const perUnit = thousandthsInUnit(unit, line.baseUnit, line.units) ?? 1000
		const start = confirmStartQuantity(line, step)
		return { line, unit, start: Math.round((start / perUnit) * 1000) / 1000 }
	})
	const [amounts, setAmounts] = useState<Record<string, number | null>>(() =>
		Object.fromEntries(rows.map((row) => [row.line.itemId, row.start])),
	)
	const touched = rows.some((row) => amounts[row.line.itemId] !== row.start)

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (submitting) return
		onSubmittingChange(true)
		setError(null)
		try {
			transferDetailSchema.parse(
				await request(`/transfers/${encodeURIComponent(transfer.id)}/${step}`, {
					method: 'POST',
					body: JSON.stringify({
						expectedVersion: transfer.version,
						// Untouched amounts are left to the region's exact figures.
						...(touched
							? {
									lines: rows.map((row) => ({
										itemId: row.line.itemId,
										amount: amounts[row.line.itemId] ?? 0,
										unit: row.unit,
									})),
								}
							: {}),
					}),
				}),
			)
			toast.success(
				step === 'send' ? t`Marked as sent.` : t`Marked as received.`,
			)
			notifyChanged()
			onDone()
			onClose()
		} catch (caught) {
			setError(i18n._(transferErrorMessage(caught)))
		} finally {
			onSubmittingChange(false)
		}
	}

	return (
		<form
			onSubmit={(event) => void submit(event)}
			noValidate
			className="flex flex-col gap-4"
			data-testid="confirm-transfer-form"
		>
			{error ? (
				<Alert variant="destructive" data-testid="confirm-transfer-error">
					<Icon name="alert-triangle" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<ul className="flex flex-col gap-3">
				{rows.map(({ line, unit }) => {
					const asked = quantity.format(line.requestedQuantity, line)
					const have = quantity.format(line.onHandAtSender, line)
					const sent = quantity.format(line.sentQuantity ?? 0, line)
					return (
						<li
							key={line.itemId}
							className="flex flex-col gap-2 rounded-xl border p-3"
							data-testid={`confirm-transfer-line-${line.itemId}`}
						>
							<div className="flex flex-wrap items-baseline justify-between gap-2">
								<span className="font-medium wrap-anywhere">
									{line.itemName}
								</span>
								<span className="text-muted-foreground text-sm">
									{step === 'send' ? (
										<Trans>
											Asked <bdi dir="ltr">{asked}</bdi>, you have{' '}
											<bdi dir="ltr">{have}</bdi>
										</Trans>
									) : (
										<Trans>
											Sent <bdi dir="ltr">{sent}</bdi>
										</Trans>
									)}
								</span>
							</div>
							<div className="flex items-center gap-2">
								<QuantityStepper
									value={amounts[line.itemId] ?? null}
									onValueChange={(amount) =>
										setAmounts((current) => ({
											...current,
											[line.itemId]: amount,
										}))
									}
									step={entryStep(unit)}
									min={0}
									decrementLabel={t`Less`}
									incrementLabel={t`More`}
									disabled={submitting}
									data-testid={`confirm-transfer-amount-${line.itemId}`}
								/>
								<span className="text-muted-foreground text-sm">
									<bdi dir="ltr">{quantity.unitName(unit, line.units)}</bdi>
								</span>
							</div>
						</li>
					)
				})}
			</ul>
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
					data-testid="confirm-transfer-submit"
				>
					{submitting ? (
						<Trans>Saving…</Trans>
					) : step === 'send' ? (
						<Trans>Confirm sent</Trans>
					) : (
						<Trans>Confirm received</Trans>
					)}
				</Button>
			</DialogFooter>
		</form>
	)
}
