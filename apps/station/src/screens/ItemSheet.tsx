import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Check, Minus, Plus, Salad, Wheat } from 'lucide-react'
import { useMemo, useState } from 'react'
import { isAvailable } from '~/lib/availability.ts'
import {
	availableOptions,
	buildLine,
	defaultSelections,
	defaultVariantPicks,
	stepOption,
	toggleOption,
	validateConfig,
	visibleGroups,
	resolveVariant,
	type Selections,
	type VariantPicks,
} from '~/lib/item-config.ts'
import { toCents, type MoneyFormatter } from '~/lib/money.ts'
import { lineTotalCents, type CartLine } from '~/lib/pricing.ts'
import { type MenuItem } from '~/lib/types.ts'
import { Badge, Button, IconButton, Modal, cn } from '~/ui/primitives.tsx'

/** Chosen options of an existing cart line, so it can be edited in place. */
function selectionsFromLine(line: CartLine): Selections {
	const selections: Selections = {}
	for (const o of line.options)
		(selections[o.groupId] ??= {})[o.optionId] = o.quantity
	return selections
}

export function ItemSheet({
	item,
	editing,
	money,
	onClose,
	onSubmit,
}: {
	item: MenuItem | null
	editing?: CartLine | null
	money: MoneyFormatter
	onClose: () => void
	onSubmit: (line: Omit<CartLine, 'id'>) => void
}) {
	if (!item) return null
	// Remount per item so state always starts from that item's defaults.
	return (
		<ItemSheetBody
			key={`${item.id}:${editing?.id ?? 'new'}`}
			item={item}
			editing={editing ?? null}
			money={money}
			onClose={onClose}
			onSubmit={onSubmit}
		/>
	)
}

function ItemSheetBody({
	item,
	editing,
	money,
	onClose,
	onSubmit,
}: {
	item: MenuItem
	editing: CartLine | null
	money: MoneyFormatter
	onClose: () => void
	onSubmit: (line: Omit<CartLine, 'id'>) => void
}) {
	const { _ } = useLingui()
	const [picks, setPicks] = useState<VariantPicks>(() => {
		if (editing?.variantId) {
			const variant = item.variations.variants.find(
				(v) => v.id === editing.variantId,
			)
			const next: VariantPicks = {}
			for (const g of item.variations.groups) {
				const value = g.values.find((v) => variant?.valueIds.includes(v.id))
				if (value) next[g.id] = value.id
			}
			return next
		}
		return defaultVariantPicks(item)
	})
	const [selections, setSelections] = useState<Selections>(() =>
		editing ? selectionsFromLine(editing) : defaultSelections(item),
	)
	const [quantity, setQuantity] = useState(editing?.quantity ?? 1)
	const [note, setNote] = useState(editing?.instructions ?? '')

	const groups = useMemo(
		() => visibleGroups(item, selections),
		[item, selections],
	)
	const problem = validateConfig(item, picks, selections)
	const preview = buildLine(item, picks, selections, quantity, note)
	const total = lineTotalCents({ ...preview, id: 'preview' })

	return (
		<Modal
			open
			onClose={onClose}
			title={item.displayName}
			size="lg"
			footer={
				<div className="flex flex-wrap items-center gap-3">
					<div className="bg-muted flex items-center gap-1 rounded-2xl p-1">
						<IconButton
							label={_(t`Fewer`)}
							onClick={() => setQuantity((q) => Math.max(1, q - 1))}
							disabled={quantity <= 1}
						>
							<Minus className="size-5" />
						</IconButton>
						<span
							className="tnum mono w-10 text-center text-xl font-bold"
							aria-live="polite"
						>
							{quantity}
						</span>
						<IconButton
							label={_(t`More`)}
							onClick={() => setQuantity((q) => Math.min(50, q + 1))}
						>
							<Plus className="size-5" />
						</IconButton>
					</div>
					<Button
						variant="primary"
						size="lg"
						className="min-w-40 flex-1"
						disabled={problem !== null}
						onClick={() =>
							onSubmit(buildLine(item, picks, selections, quantity, note))
						}
					>
						{problem ?? (
							<>
								{editing ? <Trans>Update</Trans> : <Trans>Add</Trans>} ·{' '}
								<span className="mono">{money(total)}</span>
							</>
						)}
					</Button>
				</div>
			}
		>
			<div className="space-y-6 p-5">
				{item.description ? (
					<p className="text-muted-foreground">{item.description}</p>
				) : null}
				<div className="flex flex-wrap gap-2">
					{item.isVegetarian ? (
						<Badge tone="success">
							<Salad className="size-3.5" /> <Trans>Vegetarian</Trans>
						</Badge>
					) : null}
					{item.isGlutenFree ? (
						<Badge tone="warning">
							<Wheat className="size-3.5" /> <Trans>Gluten free</Trans>
						</Badge>
					) : null}
					{item.allergens.map((a) => (
						<Badge key={a}>{a}</Badge>
					))}
				</div>

				{item.variations.groups.map((group) => (
					<section key={group.id} aria-label={group.name}>
						<SectionTitle title={group.name} hint={_(t`Required`)} />
						<div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
							{group.values.map((value) => {
								const candidate = resolveVariant(item, {
									...picks,
									[group.id]: value.id,
								})
								const soldOut =
									!candidate || !isAvailable(candidate.availabilityStatus)
								return (
									<Choice
										key={value.id}
										selected={picks[group.id] === value.id}
										disabled={soldOut}
										label={value.name}
										detail={
											soldOut
												? _(t`Sold out`)
												: candidate
													? money(toCents(candidate.price))
													: undefined
										}
										detailIsPrice={!soldOut}
										onClick={() =>
											setPicks((p) => ({ ...p, [group.id]: value.id }))
										}
									/>
								)
							})}
						</div>
					</section>
				))}

				{groups.map((group) => {
					const count = Object.values(selections[group.id] ?? {}).reduce(
						(s, q) => s + q,
						0,
					)
					const min = group.minSelections
					const max = group.maxSelections
					const hint =
						min > 0
							? max && max > min
								? _(t`Choose ${min}–${max}`)
								: _(t`Choose ${min}`)
							: max
								? _(t`Up to ${max}`)
								: _(t`Optional`)
					return (
						<section key={group.id} aria-label={group.name}>
							<SectionTitle
								title={group.name}
								hint={hint}
								met={count >= group.minSelections && group.minSelections > 0}
							/>
							<div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
								{availableOptions(group).map((option) => {
									const qty = selections[group.id]?.[option.id] ?? 0
									const price =
										option.price > 0
											? `+${money(toCents(option.price))}`
											: undefined
									if (group.selectionType === 'quantity') {
										return (
											<div
												key={option.id}
												className={cn(
													'flex min-h-16 items-center justify-between gap-2 rounded-xl border p-2 ps-3',
													qty > 0
														? 'border-primary bg-primary/8'
														: 'border-border bg-card',
												)}
											>
												<div className="min-w-0">
													<div className="truncate font-medium">
														{option.displayName}
													</div>
													{price ? (
														<div className="text-muted-foreground text-sm">
															{price}
														</div>
													) : null}
												</div>
												<div className="flex items-center gap-1">
													{qty > 0 ? (
														<IconButton
															label={_(t`Remove ${option.displayName}`)}
															onClick={() =>
																setSelections((s) =>
																	stepOption(group, option, -1, s),
																)
															}
														>
															<Minus className="size-4" />
														</IconButton>
													) : null}
													{qty > 0 ? (
														<span className="tnum mono w-5 text-center font-bold">
															{qty}
														</span>
													) : null}
													<IconButton
														label={_(t`Add ${option.displayName}`)}
														onClick={() =>
															setSelections((s) =>
																stepOption(group, option, 1, s),
															)
														}
													>
														<Plus className="size-4" />
													</IconButton>
												</div>
											</div>
										)
									}
									return (
										<Choice
											key={option.id}
											selected={qty > 0}
											label={option.displayName}
											detail={price}
											onClick={() =>
												setSelections((s) => toggleOption(group, option, s))
											}
										/>
									)
								})}
							</div>
						</section>
					)
				})}

				<section aria-label={_(t`Kitchen note`)}>
					<SectionTitle title={_(t`Kitchen note`)} hint={_(t`Optional`)} />
					<textarea
						aria-label={_(t`Kitchen note`)}
						value={note}
						onChange={(e) => setNote(e.target.value)}
						maxLength={280}
						rows={2}
						placeholder={_(t`Allergies, no onions, sauce on the side…`)}
						className="border-input bg-background focus:border-ring w-full resize-none rounded-xl border p-3 text-base outline-none"
					/>
				</section>
			</div>
		</Modal>
	)
}

function SectionTitle({
	title,
	hint,
	met,
}: {
	title: string
	hint: string
	met?: boolean
}) {
	return (
		<div className="mb-2 flex items-baseline justify-between gap-3">
			<h3 className="text-base font-semibold">{title}</h3>
			<span
				className={cn(
					'text-sm',
					met ? 'text-success font-medium' : 'text-muted-foreground',
				)}
			>
				{met ? <Trans>Done</Trans> : hint}
			</span>
		</div>
	)
}

function Choice({
	selected,
	label,
	detail,
	detailIsPrice = true,
	disabled,
	onClick,
}: {
	selected: boolean
	label: string
	detail?: string
	/** Prices are set in the monospace figures; words (Sold out) are not. */
	detailIsPrice?: boolean
	disabled?: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				'relative flex min-h-16 flex-col items-start justify-center rounded-xl border p-3 text-start transition active:scale-[0.97] disabled:opacity-45',
				selected
					? 'border-primary bg-primary/8 shadow-sm'
					: 'border-border bg-card hover:bg-accent',
			)}
		>
			<span className="pe-6 leading-tight font-medium">{label}</span>
			{detail ? (
				<span
					className={cn(
						'text-muted-foreground text-sm',
						detailIsPrice && 'mono',
					)}
				>
					{detail}
				</span>
			) : null}
			{selected ? (
				<span className="bg-primary text-primary-foreground absolute end-2 top-2 flex size-5 items-center justify-center rounded-full">
					<Check className="size-3.5" strokeWidth={3} />
				</span>
			) : null}
		</button>
	)
}
