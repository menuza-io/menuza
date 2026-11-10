import { Trans, useLingui } from '@lingui/react/macro'
import {
	logWasteResultSchema,
	PICKABLE_WASTE_REASONS,
	type StockItem,
	stockItemSchema,
	type UnitRef,
	type WasteReason,
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
import { useEffect, useId, useRef, useState } from 'react'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { ItemPicker } from '#app/components/inventory/item-picker.tsx'
import { showUndoToast } from '#app/components/undo-toast.ts'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import {
	defaultEntryUnit,
	entryStep,
	formatMoney,
	unitChoices,
} from '#app/utils/inventory/format.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { WASTE_REASON_LABELS } from '#app/utils/inventory/labels.ts'
import {
	buildWasteEntry,
	newClientId,
	type RecentWasteItem,
	readRecentWaste,
	rememberRecentWaste,
	wasteCostPreviewMinor,
	type WasteDraft,
	wasteDraftProblems,
} from '#app/utils/inventory/waste-form.ts'

/**
 * Log waste: pick an item, say how much and why, save. Saves with an
 * idempotency key (a retry after a lost answer never logs twice) and offers
 * Undo for 60 seconds. Mounted once in the Inventory chrome, so it is one
 * click from every tab.
 */
export function LogWasteDialog({
	open,
	onOpenChange,
	orgSlug,
	locationId,
	canSeeCost,
	currency,
	userName,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	orgSlug: string
	locationId: string
	canSeeCost: boolean
	currency: string
	userName: string
}) {
	const [submitting, setSubmitting] = useState(false)
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// A close mid-request reads as a cancel but the entry lands.
				if (!submitting) onOpenChange(next)
			}}
		>
			<DialogContent
				className="max-h-dvh overflow-y-auto sm:max-w-md"
				data-testid="log-waste-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Log waste</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Record what was thrown away so your stock and costs stay right.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{/* The popup unmounts on close: a reopened dialog starts clean. */}
				<LogWasteForm
					orgSlug={orgSlug}
					locationId={locationId}
					canSeeCost={canSeeCost}
					currency={currency}
					userName={userName}
					submitting={submitting}
					onSubmittingChange={setSubmitting}
					onClose={() => onOpenChange(false)}
				/>
			</DialogContent>
		</Dialog>
	)
}

function LogWasteForm({
	orgSlug,
	locationId,
	canSeeCost,
	currency,
	userName,
	submitting,
	onSubmittingChange,
	onClose,
}: {
	orgSlug: string
	locationId: string
	canSeeCost: boolean
	currency: string
	userName: string
	submitting: boolean
	onSubmittingChange: (submitting: boolean) => void
	onClose: () => void
}) {
	const { t, i18n } = useLingui()
	const client = useInventoryClient()
	const { request } = client
	const notifyChanged = useNotifyInventoryChanged()
	const quantity = useQuantityFormat()
	const amountId = useId()
	const reasonId = useId()
	const noteId = useId()

	const [item, setItem] = useState<StockItem | null>(null)
	const [amount, setAmount] = useState<number | null>(null)
	const [unit, setUnit] = useState<UnitRef | null>(null)
	const [reason, setReason] = useState<WasteReason | null>(null)
	const [note, setNote] = useState('')
	const [attempted, setAttempted] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [recents, setRecents] = useState<RecentWasteItem[]>([])
	const [loadingRecent, setLoadingRecent] = useState(false)
	// One key per entry: a retry replays it, a new entry gets a new one.
	const clientIdRef = useRef(newClientId())

	useEffect(() => {
		setRecents(readRecentWaste(orgSlug, locationId))
	}, [orgSlug, locationId])

	function choose(next: StockItem) {
		setItem(next)
		setUnit(
			defaultEntryUnit(
				next.baseUnit,
				next.countUnit,
				next.units,
				quantity.system,
			),
		)
	}

	async function chooseRecent(recent: RecentWasteItem) {
		setLoadingRecent(true)
		setError(null)
		try {
			const body = await request(
				`/items/${encodeURIComponent(recent.id)}?locationId=${encodeURIComponent(locationId)}`,
			)
			choose(stockItemSchema.parse(body))
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setLoadingRecent(false)
		}
	}

	const draft: WasteDraft = {
		item,
		amountText: amount === null ? '' : String(amount),
		unit,
		reason,
		note,
	}
	const problems = attempted ? wasteDraftProblems(draft) : []
	const costMinor = canSeeCost
		? wasteCostPreviewMinor(draft, item?.costMicro)
		: null
	const costText =
		costMinor === null ? '' : formatMoney(costMinor, currency, i18n.locale)

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (submitting) return
		setAttempted(true)
		const entry = buildWasteEntry(draft, {
			clientId: clientIdRef.current,
			locationId,
		})
		if (!entry || !item) return
		onSubmittingChange(true)
		setError(null)
		try {
			const result = logWasteResultSchema.parse(
				await request('/waste', {
					method: 'POST',
					body: JSON.stringify({ entries: [entry] }),
				}),
			)
			const accepted = result.accepted[0]
			const entryId = accepted?.id ?? result.duplicates[0]?.id
			rememberRecentWaste(orgSlug, locationId, { id: item.id, name: item.name })
			notifyChanged()
			const itemName = item.name
			const amountText = accepted
				? quantity.format(accepted.quantity, {
						baseUnit: item.baseUnit,
						countUnit: entry.unit,
						units: item.units,
					})
				: `${new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 3 }).format(entry.amount)} ${quantity.unitName(entry.unit, item.units)}`
			clientIdRef.current = newClientId()
			onClose()
			if (entryId) {
				showUndoToast({
					message: t`Waste logged: ${itemName}, ${amountText}`,
					undoLabel: t`Undo`,
					undoneMessage: t`Waste undone.`,
					failedMessage: t`We could not undo that. Open Waste and try again.`,
					onUndo: async () => {
						await request(`/waste/${encodeURIComponent(entryId)}/undo`, {
							method: 'POST',
							body: JSON.stringify({ clientId: newClientId('u') }),
						})
						notifyChanged()
					},
				})
			}
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			onSubmittingChange(false)
		}
	}

	const units = item
		? unitChoices(item.baseUnit, item.units, quantity.system)
		: []
	const showFractions =
		item !== null &&
		unit !== null &&
		(item.baseUnit === 'piece' || unit.startsWith('unit:'))

	return (
		<form
			onSubmit={(event) => void submit(event)}
			noValidate
			className="flex flex-col gap-4"
			data-testid="log-waste-form"
		>
			{error ? (
				<Alert variant="destructive" data-testid="log-waste-error">
					<Icon name="alert-triangle" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			<div className="flex flex-col gap-2">
				<ItemPicker
					id="log-waste-item"
					label={<Trans>What was wasted?</Trans>}
					client={client as Pick<InventoryClient, 'request'>}
					locationId={locationId}
					value={item}
					onChange={choose}
					placeholder={t`Choose an item`}
					error={problems.includes('item') ? t`Choose an item.` : null}
					disabled={submitting}
					testId="log-waste-item"
				/>
				{recents.length > 0 && !item ? (
					<div
						className="flex flex-wrap items-center gap-1.5"
						data-testid="log-waste-recent"
					>
						<span className="text-muted-foreground text-xs">
							<Trans>Recent</Trans>
						</span>
						{recents.map((recent) => (
							<Button
								key={recent.id}
								type="button"
								variant="outline"
								size="xs"
								disabled={loadingRecent || submitting}
								onClick={() => void chooseRecent(recent)}
								data-testid={`log-waste-recent-${recent.id}`}
							>
								<span className="max-w-40 truncate">{recent.name}</span>
							</Button>
						))}
					</div>
				) : null}
			</div>

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
						fractions={showFractions}
						decrementLabel={t`Less`}
						incrementLabel={t`More`}
						fractionLabel={(fraction) => t`Add ${fraction}`}
						disabled={submitting}
						invalid={problems.includes('amount')}
						data-testid="log-waste-amount"
					/>
					{item ? (
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
							{units.map((choice) => (
								<ToggleGroupItem
									key={choice}
									value={choice}
									className="h-11 min-w-11 md:h-7"
									data-testid={`log-waste-unit-${choice}`}
								>
									<bdi dir="ltr">{quantity.unitName(choice, item.units)}</bdi>
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					) : null}
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
					onValueChange={(next) => {
						setReason((next[0] as WasteReason | undefined) ?? null)
					}}
					className="flex-wrap"
				>
					{PICKABLE_WASTE_REASONS.map((value) => (
						<ToggleGroupItem
							key={value}
							value={value}
							className="h-11 md:h-8"
							data-testid={`log-waste-reason-${value}`}
						>
							{i18n._(WASTE_REASON_LABELS[value])}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				{problems.includes('reason') ? (
					<FieldError>
						<Trans>Choose why it was wasted.</Trans>
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
					data-testid="log-waste-note"
				/>
			</Field>

			<div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-sm">
				{costMinor !== null ? (
					<span data-testid="log-waste-cost">
						<Trans>
							Cost{' '}
							<bdi dir="ltr" className="text-foreground font-medium">
								{costText}
							</bdi>
						</Trans>
					</span>
				) : (
					<span />
				)}
				{userName ? (
					<span data-testid="log-waste-actor">
						<Trans>
							Logged as <span className="wrap-anywhere">{userName}</span>
						</Trans>
					</span>
				) : null}
			</div>

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
					data-testid="log-waste-submit"
				>
					{submitting ? <Trans>Saving…</Trans> : <Trans>Log waste</Trans>}
				</Button>
			</DialogFooter>
		</form>
	)
}
