import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	INVENTORY_BASE_UNITS,
	type InventoryBaseUnit,
	type StationCatalog,
	type StationItem,
	type UnitRef,
} from '@repo/inventory'
import { Icon } from '@repo/ui/icon'
import { useRef, useState } from 'react'
import { BigStepper } from './BigStepper.tsx'
import {
	cashLineFromDraft,
	cashLineFromItem,
	filterItems,
	unitChoices,
	unitLabel,
	unitStep,
	unitTakesFractions,
	type CashPurchaseLineDraft,
} from './model.ts'
import { type InvoicePhoto } from './photo.ts'
import { Badge, Button, fieldClass, Input, Select } from '~/ui/primitives.tsx'

const MAX_SHOWN_ITEMS = 20

/**
 * Cash purchase from the market (#466): pick existing items or type a new draft
 * item with its base unit, enter quantity and amount paid, and optionally snap
 * the receipt. Amounts are entered once here and never shown afterwards.
 */
export function CashPurchaseForm({
	catalog,
	lines,
	onChangeLines,
	photo,
	photoProblem,
	onPickPhoto,
	onClearPhoto,
	problem,
	locale,
}: {
	catalog: StationCatalog
	lines: CashPurchaseLineDraft[]
	onChangeLines: React.Dispatch<React.SetStateAction<CashPurchaseLineDraft[]>>
	photo: (InvoicePhoto & { url: string }) | null
	photoProblem: string | null
	onPickPhoto: (file: File | undefined) => void
	onClearPhoto: () => void
	problem: string | null
	locale: string
}) {
	const { _ } = useLingui()
	const [query, setQuery] = useState('')
	const [draftName, setDraftName] = useState('')
	const [draftUnit, setDraftUnit] = useState<InventoryBaseUnit>('g')
	const picker = useRef<HTMLInputElement>(null)
	const draftSerial = useRef(0)

	const patch = (key: string, change: Partial<CashPurchaseLineDraft>) =>
		onChangeLines((before) =>
			before.map((line) => (line.key === key ? { ...line, ...change } : line)),
		)

	const addExisting = (item: StationItem) => {
		onChangeLines((before) =>
			before.some((line) => line.key === `item:${item.id}`)
				? before
				: [...before, cashLineFromItem(item)],
		)
	}

	const addDraft = () => {
		const trimmed = draftName.trim()
		if (!trimmed) return
		draftSerial.current += 1
		const line = cashLineFromDraft(
			`draft:${draftSerial.current}`,
			trimmed,
			draftUnit,
		)
		onChangeLines((before) => [...before, line])
		setDraftName('')
	}

	const matches = filterItems(catalog.items, query).slice(0, MAX_SHOWN_ITEMS)

	const baseUnitLabel = (unit: InventoryBaseUnit): string => {
		switch (unit) {
			case 'g':
				return _(t`Grams (g)`)
			case 'ml':
				return _(t`Millilitres (ml)`)
			case 'piece':
				return _(t`Pieces`)
		}
	}

	return (
		<div className="flex flex-col gap-5">
			<h3 className="text-xl font-semibold break-words">
				<Trans>Cash purchase</Trans>
			</h3>
			{lines.length > 0 ? (
				<ul className="flex flex-col gap-3">
					{lines.map((line) => {
						const choices = unitChoices({
							baseUnit: line.baseUnit,
							units: line.units,
							countUnit: line.countUnit,
						})
						const unit: UnitRef = line.unit
						const name = line.itemName
						return (
							<li
								key={line.key}
								className="border-border bg-card flex flex-col gap-3 rounded-(--station-panel-radius) border p-4"
							>
								<div className="flex items-start justify-between gap-3">
									<div className="flex min-w-0 flex-wrap items-center gap-2">
										<p className="text-base font-semibold break-words">
											{name}
										</p>
										{line.draftItem ? (
											<Badge tone="muted">
												<Trans>New item</Trans>
											</Badge>
										) : null}
									</div>
									<Button
										variant="ghost"
										aria-label={_(t`Remove ${name}`)}
										onClick={() =>
											onChangeLines((before) =>
												before.filter((entry) => entry.key !== line.key),
											)
										}
									>
										<Icon name="trash-2" className="size-5" />
									</Button>
								</div>
								<div className="flex flex-wrap items-start gap-4">
									<div className="flex flex-col gap-1">
										<span className="text-muted-foreground text-sm">
											<Trans>Quantity</Trans>
										</span>
										<div className="flex flex-wrap items-start gap-2">
											<BigStepper
												value={line.amount}
												label={name}
												step={unitStep(unit)}
												fractions={unitTakesFractions(unit)}
												onChange={(amount) => patch(line.key, { amount })}
											/>
											<Select
												aria-label={_(t`Unit for ${name}`)}
												containerClassName="w-40"
												value={unit}
												onChange={(event) =>
													patch(line.key, {
														unit: event.target.value,
														amount: null,
													})
												}
											>
												{choices.map((ref) => (
													<option key={ref} value={ref}>
														{unitLabel(ref, line.units, locale)}
													</option>
												))}
											</Select>
										</div>
									</div>
									<label className="flex flex-col gap-1">
										<span className="text-muted-foreground text-sm">
											<Trans>Amount paid</Trans>
										</span>
										<Input
											type="text"
											inputMode="decimal"
											autoComplete="off"
											dir="ltr"
											placeholder="0.00"
											aria-label={_(t`Amount paid for ${name}`)}
											value={line.amountPaidText}
											onChange={(event) =>
												patch(line.key, {
													amountPaidText: event.target.value,
												})
											}
											className="h-14 w-36 text-center text-xl font-semibold tabular-nums"
										/>
									</label>
								</div>
							</li>
						)
					})}
				</ul>
			) : null}
			<section className="flex flex-col gap-2">
				<h4 className="text-base font-semibold">
					<Trans>Pick an item</Trans>
				</h4>
				<input
					type="search"
					className={fieldClass}
					value={query}
					placeholder={_(t`Search items`)}
					autoComplete="off"
					onChange={(event) => setQuery(event.target.value)}
				/>
				{matches.length > 0 ? (
					<ul className="flex flex-col gap-2">
						{matches.map((item) => {
							const added = lines.some((line) => line.key === `item:${item.id}`)
							return (
								<li key={item.id}>
									<button
										type="button"
										disabled={added}
										onClick={() => addExisting(item)}
										className="border-border bg-card hover:bg-accent flex min-h-14 w-full items-center justify-between gap-3 rounded-(--station-control-radius) border px-4 py-2 text-start disabled:opacity-50"
									>
										<span className="min-w-0 font-medium break-words">
											{item.name}
										</span>
										<Icon
											name={added ? 'check' : 'plus'}
											className="size-5 shrink-0"
											aria-hidden
										/>
									</button>
								</li>
							)
						})}
					</ul>
				) : null}
			</section>
			<section className="border-border flex flex-col gap-2 border-t pt-4">
				<h4 className="text-base font-semibold">
					<Trans>Or add a new item</Trans>
				</h4>
				<div className="flex flex-wrap items-end gap-2">
					<label className="flex min-w-48 flex-1 flex-col gap-1">
						<span className="text-muted-foreground text-sm">
							<Trans>Item name</Trans>
						</span>
						<Input
							value={draftName}
							maxLength={80}
							aria-label={_(t`New item name`)}
							placeholder={_(t`e.g. Fresh mint`)}
							onChange={(event) => setDraftName(event.target.value)}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-muted-foreground text-sm">
							<Trans>Base unit</Trans>
						</span>
						<Select
							aria-label={_(t`New item base unit`)}
							containerClassName="w-44"
							value={draftUnit}
							onChange={(event) =>
								setDraftUnit(event.target.value as InventoryBaseUnit)
							}
						>
							{INVENTORY_BASE_UNITS.map((unit) => (
								<option key={unit} value={unit}>
									{baseUnitLabel(unit)}
								</option>
							))}
						</Select>
					</label>
					<Button disabled={!draftName.trim()} onClick={addDraft}>
						<Icon name="plus" className="size-4" />
						<Trans>Add new item</Trans>
					</Button>
				</div>
			</section>
			<section className="flex flex-col gap-2">
				<h4 className="text-base font-semibold">
					<Trans>Photo of the receipt (optional)</Trans>
				</h4>
				<input
					ref={picker}
					type="file"
					accept="image/*"
					capture="environment"
					className="sr-only"
					tabIndex={-1}
					aria-label={_(t`Receipt photo file`)}
					onChange={(event) => {
						onPickPhoto(event.target.files?.[0])
						event.target.value = ''
					}}
				/>
				<div className="flex flex-wrap items-center gap-3">
					<Button onClick={() => picker.current?.click()}>
						<Icon name="camera" className="size-5" />
						{photo ? <Trans>Take it again</Trans> : <Trans>Take a photo</Trans>}
					</Button>
					{photo ? (
						<>
							<img
								src={photo.url}
								alt={_(t`The receipt photo`)}
								className="border-border h-16 rounded-(--station-control-radius) border object-cover"
							/>
							<Button variant="ghost" onClick={onClearPhoto}>
								<Icon name="x" className="size-4" />
								<Trans>Remove</Trans>
							</Button>
						</>
					) : null}
				</div>
				{photoProblem ? (
					<p role="alert" className="text-destructive text-sm">
						{photoProblem}
					</p>
				) : null}
			</section>
			{problem ? (
				<p role="alert" className="text-destructive text-sm">
					{problem}
				</p>
			) : null}
		</div>
	)
}
