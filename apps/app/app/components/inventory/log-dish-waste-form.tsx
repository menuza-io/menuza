import { Trans, useLingui } from '@lingui/react/macro'
import {
	logWasteDishResultSchema,
	PICKABLE_WASTE_REASONS,
	type WasteReason,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { DialogFooter } from '@repo/ui/dialog'
import { Field, FieldError, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { QuantityStepper } from '@repo/ui/quantity-stepper'
import { Textarea } from '@repo/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNotifyInventoryChanged } from '#app/components/inventory/inventory-prefs.tsx'
import { showUndoToast } from '#app/components/undo-toast.ts'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { WASTE_REASON_LABELS } from '#app/utils/inventory/labels.ts'
import { type WasteDish } from '#app/utils/inventory/waste-dishes.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'

/**
 * Log a whole dish as waste (#517): pick a dish (searched by name), how many,
 * the size and options (they change the ingredients like a sale does) and why.
 * The region writes one waste row per ingredient by the recipe in force now,
 * grouped under the dish, so the log reads "2 x Chicken shawarma"; Undo takes
 * the whole group back. A dish with no recipe is refused ("Add a recipe
 * first"), unless it has a typed cost.
 */
export function LogDishWasteForm({
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
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const noteId = useId()
	const reasonId = useId()
	const [dishes, setDishes] = useState<WasteDish[] | null>(null)
	const [loadFailed, setLoadFailed] = useState(false)
	const [search, setSearch] = useState('')
	const [dish, setDish] = useState<WasteDish | null>(null)
	const [variantId, setVariantId] = useState<string | null>(null)
	const [optionIds, setOptionIds] = useState<string[]>([])
	const [quantity, setQuantity] = useState<number | null>(1)
	const [reason, setReason] = useState<WasteReason | null>(null)
	const [note, setNote] = useState('')
	const [attempted, setAttempted] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const clientIdRef = useRef(newClientId('wd'))

	useEffect(() => {
		let live = true
		fetch(`/${orgSlug}/inventory-dishes`, {
			headers: { Accept: 'application/json' },
		})
			.then(
				(response): Promise<{ dishes?: WasteDish[] }> =>
					response.ok
						? (response.json() as Promise<{ dishes?: WasteDish[] }>)
						: Promise.reject(new Error('failed')),
			)
			.then((body) => {
				if (live) setDishes(body.dishes ?? [])
			})
			.catch(() => {
				if (live) setLoadFailed(true)
			})
		return () => {
			live = false
		}
	}, [orgSlug])

	const matches = useMemo(() => {
		const needle = search.trim().toLowerCase()
		return (dishes ?? [])
			.filter(
				(entry) => needle === '' || entry.name.toLowerCase().includes(needle),
			)
			.slice(0, 8)
	}, [dishes, search])

	const problems = {
		dish: attempted && dish === null,
		variant:
			attempted &&
			dish !== null &&
			dish.variants.length > 0 &&
			variantId === null,
		quantity: attempted && !(quantity && quantity >= 1),
		reason: attempted && reason === null,
	}

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (submitting) return
		setAttempted(true)
		if (
			!dish ||
			!(quantity && quantity >= 1) ||
			!reason ||
			(dish.variants.length > 0 && variantId === null)
		) {
			return
		}
		onSubmittingChange(true)
		setError(null)
		try {
			const result = logWasteDishResultSchema.parse(
				await request('/waste/dishes', {
					method: 'POST',
					body: JSON.stringify({
						clientId: clientIdRef.current,
						locationId,
						menuItemId: dish.id,
						...(variantId ? { variantId } : {}),
						...(optionIds.length > 0
							? { options: optionIds.map((optionId) => ({ optionId })) }
							: {}),
						quantity,
						reason,
						...(note.trim() ? { note: note.trim() } : {}),
					}),
				}),
			)
			clientIdRef.current = newClientId('wd')
			notifyChanged()
			const name = dish.name
			const count = quantity
			const cost =
				canSeeCost && result.valueMinor !== undefined
					? formatMoney(
							result.valueMinor,
							result.currency ?? currency,
							i18n.locale,
						)
					: null
			onClose()
			showUndoToast({
				message: cost
					? t`Waste logged: ${count} x ${name} (${cost})`
					: t`Waste logged: ${count} x ${name}`,
				undoLabel: t`Undo`,
				undoneMessage: t`Waste undone.`,
				failedMessage: t`We could not undo that. Open Waste and try again.`,
				onUndo: async () => {
					await request(`/waste/dishes/${encodeURIComponent(result.id)}/undo`, {
						method: 'POST',
						body: JSON.stringify({ clientId: newClientId('u') }),
					})
					notifyChanged()
				},
			})
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
			data-testid="log-dish-waste-form"
		>
			{error ? (
				<Alert variant="destructive" data-testid="log-dish-error">
					<Icon name="alert-triangle" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			<Field data-invalid={problems.dish ? true : undefined}>
				<FieldLabel>
					<Trans>Which dish?</Trans>
				</FieldLabel>
				{dish ? (
					<div className="flex items-center justify-between gap-2 rounded-md border p-2">
						<span
							className="font-medium wrap-anywhere"
							data-testid="log-dish-chosen"
						>
							{dish.name}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={submitting}
							onClick={() => {
								setDish(null)
								setVariantId(null)
								setOptionIds([])
							}}
						>
							<Trans>Change</Trans>
						</Button>
					</div>
				) : (
					<>
						<Input
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder={t`Search dishes`}
							aria-label={t`Search dishes`}
							disabled={submitting}
							data-testid="log-dish-search"
						/>
						{loadFailed ? (
							<p className="text-destructive text-sm" role="alert">
								<Trans>We could not load your dishes. Try again.</Trans>
							</p>
						) : dishes === null ? (
							<p className="text-muted-foreground text-sm" role="status">
								<Trans>Loading…</Trans>
							</p>
						) : matches.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								<Trans>No dishes match.</Trans>
							</p>
						) : (
							<ul className="flex flex-col divide-y rounded-md border">
								{matches.map((entry) => (
									<li key={entry.id}>
										<button
											type="button"
											className="hover:bg-accent w-full p-2 text-start wrap-anywhere"
											onClick={() => setDish(entry)}
											data-testid={`log-dish-option-${entry.id}`}
										>
											{entry.name}
										</button>
									</li>
								))}
							</ul>
						)}
					</>
				)}
				{problems.dish ? (
					<FieldError>
						<Trans>Choose a dish.</Trans>
					</FieldError>
				) : null}
			</Field>

			{dish && dish.variants.length > 0 ? (
				<Field data-invalid={problems.variant ? true : undefined}>
					<FieldLabel>
						<Trans>Size</Trans>
					</FieldLabel>
					<ToggleGroup
						variant="outline"
						spacing={1}
						value={variantId ? [variantId] : []}
						disabled={submitting}
						onValueChange={(next) => setVariantId(next[0] ?? null)}
						className="flex-wrap"
					>
						{dish.variants.map((variant) => (
							<ToggleGroupItem
								key={variant.id}
								value={variant.id}
								className="h-11 md:h-8"
								data-testid={`log-dish-variant-${variant.id}`}
							>
								{variant.label}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
					{problems.variant ? (
						<FieldError>
							<Trans>Choose a size.</Trans>
						</FieldError>
					) : null}
				</Field>
			) : null}

			{dish
				? dish.groups
						.filter((group) => group.options.length > 0)
						.map((group) => (
							<Field key={group.id}>
								<FieldLabel>{group.name}</FieldLabel>
								<ToggleGroup
									multiple
									variant="outline"
									spacing={1}
									value={group.options
										.map((option) => option.id)
										.filter((id) => optionIds.includes(id))}
									disabled={submitting}
									onValueChange={(next) =>
										setOptionIds((current) => [
											...current.filter(
												(id) =>
													!group.options.some((option) => option.id === id),
											),
											...next,
										])
									}
									className="flex-wrap"
								>
									{group.options.map((option) => (
										<ToggleGroupItem
											key={option.id}
											value={option.id}
											className="h-11 md:h-8"
											data-testid={`log-dish-extra-${option.id}`}
										>
											{option.name}
										</ToggleGroupItem>
									))}
								</ToggleGroup>
							</Field>
						))
				: null}

			<Field data-invalid={problems.quantity ? true : undefined}>
				<FieldLabel>
					<Trans>How many?</Trans>
				</FieldLabel>
				<QuantityStepper
					value={quantity}
					onValueChange={setQuantity}
					step={1}
					min={1}
					decrementLabel={t`Fewer`}
					incrementLabel={t`More`}
					disabled={submitting}
					invalid={problems.quantity}
					data-testid="log-dish-quantity"
				/>
				{problems.quantity ? (
					<FieldError>
						<Trans>Enter how many, at least one.</Trans>
					</FieldError>
				) : null}
			</Field>

			<Field data-invalid={problems.reason ? true : undefined}>
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
						setReason((next[0] as WasteReason | undefined) ?? null)
					}
					className="flex-wrap"
				>
					{PICKABLE_WASTE_REASONS.map((value) => (
						<ToggleGroupItem
							key={value}
							value={value}
							className="h-11 md:h-8"
							data-testid={`log-dish-reason-${value}`}
						>
							{i18n._(WASTE_REASON_LABELS[value])}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				{problems.reason ? (
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
				/>
			</Field>

			{userName ? (
				<p className="text-muted-foreground text-sm">
					<Trans>
						Logged as <span className="wrap-anywhere">{userName}</span>
					</Trans>
				</p>
			) : null}

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
					data-testid="log-dish-submit"
				>
					{submitting ? <Trans>Saving…</Trans> : <Trans>Log waste</Trans>}
				</Button>
			</DialogFooter>
		</form>
	)
}
