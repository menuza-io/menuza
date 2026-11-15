import { type I18n, type MessageDescriptor } from '@lingui/core'
import { Plural, Trans, msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { useId, useState } from 'react'
import {
	type MenuCard,
	type MenuCardKind,
	type MenuCardOption,
	type MenuCardPreview,
	type MenuCardPreviewBlock,
	type MenuCardPreviewRow,
	type MenuCardSkipReason,
} from '#app/utils/menu/menu-cards.ts'

/** What the owner can do with a card they don't want to accept. */
export type CardSkipChoice = 'later' | MenuCardSkipReason

const KIND_TITLES: Record<MenuCardKind, MessageDescriptor> = {
	merge_duplicates: msg`Merge duplicate dishes`,
	make_sizes: msg`Make sizes`,
	merge_categories: msg`Merge categories`,
	split_add_remove: msg`Split add and remove`,
	make_required: msg`Make this choice required`,
	half_whole_toppings: msg`Half and whole toppings`,
	check_price: msg`Check this price`,
	typo: msg`Fix spelling`,
	capitals: msg`Consistent capitals`,
	missing_choice: msg`Add the missing choice`,
	selection_limits: msg`Fix selection limits`,
	required_first: msg`Required choices first`,
	option_order: msg`Put options in order`,
	no_option_style: msg`Same wording for “no” options`,
	free_dish: msg`This dish is free`,
	category_order: msg`Category order`,
}

const KIND_REASONS: Record<MenuCardKind, MessageDescriptor> = {
	merge_duplicates: msg`These dishes look the same. Keeping one avoids guests seeing it twice.`,
	make_sizes: msg`These dishes differ only by size. One dish with sizes is easier to order.`,
	merge_categories: msg`These categories look the same. One category is easier to browse.`,
	split_add_remove: msg`Adding and removing are mixed in one choice. Two choices are clearer.`,
	make_required: msg`Guests can skip this choice, but most dishes need it.`,
	half_whole_toppings: msg`Guests can pick which half gets each topping.`,
	check_price: msg`This price looks out of line with similar items.`,
	typo: msg`This name looks misspelled.`,
	capitals: msg`Names use mixed capital letters. One style looks tidier.`,
	missing_choice: msg`A similar dish has a choice that this one lacks.`,
	selection_limits: msg`The minimum and maximum don't fit this choice.`,
	required_first: msg`Putting required choices first helps guests order faster.`,
	option_order: msg`Options in a sensible order are quicker to scan.`,
	no_option_style: msg`“No” options use different wording across your menu.`,
	free_dish: msg`This dish costs nothing, so guests can order it for free.`,
	category_order: msg`Categories are easier to browse in a familiar order.`,
}

const NOTE_LABELS: Record<string, MessageDescriptor> = {
	hidden: msg`Hidden`,
	new: msg`New`,
	required: msg`Required`,
	optional: msg`Optional`,
}

const CHANGE_LABELS: Record<
	NonNullable<MenuCardPreviewRow['change']>,
	MessageDescriptor
> = {
	added: msg`Added`,
	removed: msg`Removed`,
	changed: msg`Changed`,
	hidden: msg`Hidden`,
	moved: msg`Moved`,
}

const WARNING_LABELS: Record<string, MessageDescriptor> = {
	prices_differ: msg`The prices differ. Check them before you accept.`,
	shared_group: msg`This choice is shared with other dishes, so they change too.`,
	empty_group: msg`This choice has no options yet.`,
}

const GROUP_LABELS: Record<string, MessageDescriptor> = {
	in_menus: msg`On menus`,
	in_categories: msg`In categories`,
	in_modifier_groups: msg`In modifier groups`,
	contains_categories: msg`Categories`,
	contains_items: msg`Items`,
	contains_options: msg`Options`,
	used_by_items: msg`Items using it`,
	nested_in_options: msg`Options that open it`,
	discounts: msg`Discounts`,
	drops: msg`Drops`,
	print_designs: msg`Print designs`,
	pos_links: msg`Connected platforms`,
}

const MAX_REFERENCE_NAMES = 5

export function cardKindTitle(_: I18n['_'], kind: MenuCardKind): string {
	return _(KIND_TITLES[kind])
}

/** The option a card starts on. */
export function initialCardOptionId(card: MenuCard): string | undefined {
	return card.defaultOptionId ?? card.options?.[0]?.id
}

/** True when Accept needs a typed value (so it can't be accepted in bulk). */
export function cardNeedsInput(card: MenuCard, optionId?: string): boolean {
	const id = optionId ?? initialCardOptionId(card)
	return Boolean(card.options?.find((option) => option.id === id)?.input)
}

function optionLabel(_: I18n['_'], option: MenuCardOption): string {
	const subject = option.subject
	switch (option.code) {
		case 'keep':
			return subject ? _(t`Keep ${subject}`) : _(t`Keep this one`)
		case 'title':
			return _(t`Title Case`)
		case 'sentence':
			return _(t`Sentence case`)
		case 'upper':
			return _(t`UPPER CASE`)
		case 'set_price':
			return _(t`Set the price`)
		case 'require':
			return _(t`Make it required`)
		case 'attach':
			return subject ? _(t`Use ${subject}`) : _(t`Use an existing choice`)
		case 'create':
			return subject ? _(t`Create ${subject}`) : _(t`Create a new choice`)
		case 'add_group':
			return subject ? _(t`Add ${subject}`) : _(t`Add the choice`)
		case 'make_multiple':
			return _(t`Let guests pick several`)
		case 'max_one':
			return _(t`Allow only one`)
		case 'make_single':
			return _(t`Make it a single choice`)
		default:
			return subject ?? _(t`Another way`)
	}
}

function formatPrice(price: number): string {
	return price.toFixed(2)
}

// --- Preview ------------------------------------------------------------------

function ChangeMark({ change }: { change: MenuCardPreviewRow['change'] }) {
	const { _ } = useLingui()
	if (!change) return <span aria-hidden className="size-4 shrink-0" />
	const icon =
		change === 'added'
			? 'plus'
			: change === 'moved'
				? 'move-up-right'
				: change === 'changed'
					? 'pencil'
					: 'minus'
	const tone =
		change === 'added'
			? 'text-success'
			: change === 'removed'
				? 'text-destructive'
				: change === 'changed'
					? 'text-warning'
					: 'text-muted-foreground'
	return (
		<>
			<Icon name={icon} aria-hidden className={`size-4 shrink-0 ${tone}`} />
			<span className="sr-only">{_(CHANGE_LABELS[change])}</span>
		</>
	)
}

function PreviewRow({ row }: { row: MenuCardPreviewRow }) {
	const struck = row.change === 'removed' || row.change === 'hidden'
	return (
		<li className="flex items-start gap-2 text-sm">
			<ChangeMark change={row.change} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span
					className={
						struck
							? 'text-muted-foreground wrap-anywhere line-through'
							: 'wrap-anywhere'
					}
				>
					{row.text}
				</span>
				{row.detail ? (
					<span className="text-muted-foreground text-xs wrap-anywhere">
						{row.detail}
					</span>
				) : null}
			</span>
			{row.price !== undefined ? (
				<span className="text-muted-foreground shrink-0 tabular-nums">
					{row.price === null ? '—' : formatPrice(row.price)}
				</span>
			) : null}
		</li>
	)
}

function PreviewBlock({ block }: { block: MenuCardPreviewBlock }) {
	const { _ } = useLingui()
	const note = block.note ? NOTE_LABELS[block.note] : undefined
	return (
		<div className="space-y-1.5">
			<p className="flex flex-wrap items-center gap-2 text-sm font-medium">
				<span className="wrap-anywhere">{block.title}</span>
				{note ? (
					<span className="text-muted-foreground text-xs font-normal">
						{_(note)}
					</span>
				) : null}
			</p>
			{block.rows.length > 0 ? (
				<ul className="space-y-1">
					{block.rows.map((row, index) => (
						<PreviewRow key={index} row={row} />
					))}
				</ul>
			) : null}
		</div>
	)
}

function PreviewSide({
	label,
	blocks,
	tone,
}: {
	label: string
	blocks: MenuCardPreviewBlock[]
	tone: 'before' | 'after'
}) {
	return (
		<section
			aria-label={label}
			className={
				tone === 'after'
					? 'bg-primary/5 min-w-0 flex-1 space-y-2 rounded-lg border p-3'
					: 'bg-muted/60 min-w-0 flex-1 space-y-2 rounded-lg p-3'
			}
		>
			<p className="text-muted-foreground text-xs font-medium">{label}</p>
			{blocks.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Nothing</Trans>
				</p>
			) : (
				blocks.map((block, index) => <PreviewBlock key={index} block={block} />)
			)}
		</section>
	)
}

export function MenuCardPreviewView({ preview }: { preview: MenuCardPreview }) {
	const { _ } = useLingui()
	return (
		<div className="flex flex-col items-stretch gap-2">
			<PreviewSide label={_(t`Now`)} blocks={preview.before} tone="before" />
			<Icon
				name="arrow-right"
				aria-hidden
				className="text-muted-foreground size-4 rotate-90 self-center"
			/>
			<PreviewSide
				label={_(t`After you accept`)}
				blocks={preview.after}
				tone="after"
			/>
		</div>
	)
}

// --- References ---------------------------------------------------------------

function CardReferences({
	references,
}: {
	references: MenuCard['references']
}) {
	const { _ } = useLingui()
	const shown = (references ?? []).filter((ref) => ref.groups.length > 0)
	if (shown.length === 0) return null
	return (
		<div className="space-y-2 rounded-lg border p-3">
			<p className="text-sm font-medium">
				<Trans>Still used in</Trans>
			</p>
			{shown.map((reference) => (
				<div key={`${reference.entity}:${reference.id}`} className="space-y-1">
					<p className="text-muted-foreground text-xs wrap-anywhere">
						{reference.name}
					</p>
					<ul className="space-y-0.5 text-sm">
						{reference.groups.map((group) => {
							const label = GROUP_LABELS[group.kind]
							const names = group.names.slice(0, MAX_REFERENCE_NAMES)
							const more = group.total - names.length
							return (
								<li key={group.kind} className="wrap-anywhere">
									{label ? (
										<span className="font-medium">{_(label)} </span>
									) : null}
									<span className="text-muted-foreground tabular-nums">
										{group.total}
									</span>
									{names.length > 0 ? (
										<span className="text-muted-foreground">
											{': '}
											{names.join(', ')}
											{more > 0 ? (
												<>
													{' '}
													<Plural
														value={more}
														one="and # more"
														other="and # more"
													/>
												</>
											) : null}
										</span>
									) : null}
								</li>
							)
						})}
					</ul>
				</div>
			))}
		</div>
	)
}

// --- Skip menu ----------------------------------------------------------------

/** Skip with a reason. `later` is offered only when `includeLater` is set. */
export function CardSkipMenu({
	disabled,
	includeLater = true,
	label,
	onChoose,
}: {
	disabled?: boolean
	includeLater?: boolean
	label?: string
	onChoose: (choice: CardSkipChoice) => void
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button variant="outline" disabled={disabled}>
						{label ?? <Trans>Skip</Trans>}
						<Icon name="chevron-down" aria-hidden className="size-4" />
					</Button>
				}
			/>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onClick={() => onChoose('not_a_problem')}>
					<Trans>Not a problem</Trans>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => onChoose('fixed_myself')}>
					<Trans>I fixed it myself</Trans>
				</DropdownMenuItem>
				{includeLater ? (
					<DropdownMenuItem onClick={() => onChoose('later')}>
						<Trans>Later</Trans>
					</DropdownMenuItem>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// --- The card -----------------------------------------------------------------

function CardInput({
	kind,
	value,
	onChange,
}: {
	kind: 'price' | 'text'
	value: string
	onChange: (value: string) => void
}) {
	const id = useId()
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>
				{kind === 'price' ? <Trans>Price</Trans> : <Trans>New text</Trans>}
			</Label>
			<Input
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				{...(kind === 'price'
					? { type: 'number', inputMode: 'decimal', min: 0, step: '0.01' }
					: { type: 'text', maxLength: 300 })}
			/>
		</div>
	)
}

function inputIsValid(kind: 'price' | 'text', value: string): boolean {
	const trimmed = value.trim()
	if (!trimmed) return false
	if (kind === 'text') return true
	const number = Number(trimmed)
	return Number.isFinite(number) && number >= 0
}

/** The body, choices and buttons of one review card (#92, #234). */
export function MenuReviewCardView({
	card,
	busy,
	onAccept,
	onSkip,
	ref,
}: {
	card: MenuCard
	busy: boolean
	onAccept: (optionId: string | undefined, input: string | undefined) => void
	onSkip: (choice: CardSkipChoice) => void
	ref: React.Ref<HTMLDivElement>
}) {
	const { _ } = useLingui()
	const titleId = useId()
	const [optionId, setOptionId] = useState(() => initialCardOptionId(card))
	const [input, setInput] = useState('')
	const options = card.options ?? []
	const selected = options.find((option) => option.id === optionId)
	const inputKind = selected?.input ?? null
	const preview = selected?.preview ?? card.preview
	const warnings = [
		...new Set([...(card.warnings ?? []), ...(selected?.warnings ?? [])]),
	].filter((code) => code in WARNING_LABELS)
	const canAccept = !inputKind || inputIsValid(inputKind, input)

	return (
		<div
			ref={ref}
			tabIndex={-1}
			role="group"
			aria-labelledby={titleId}
			className="bg-card animate-in fade-in-0 slide-in-from-bottom-2 relative max-h-[60vh] space-y-4 overflow-y-auto rounded-xl border p-4 shadow-sm duration-200 outline-none focus-visible:ring-2 motion-reduce:animate-none"
		>
			<div className="min-w-0 space-y-0.5">
				<h3 id={titleId} className="text-base font-semibold">
					{cardKindTitle(_, card.kind)}
				</h3>
				<p className="text-muted-foreground text-sm wrap-anywhere">
					{card.subject}
				</p>
			</div>

			<p className="text-muted-foreground text-xs">
				{_(KIND_REASONS[card.kind])}
			</p>

			{card.explanation ? (
				<p className="text-muted-foreground flex items-start gap-1.5 text-xs italic">
					<Icon
						name="sparkles"
						aria-hidden
						className="mt-0.5 size-3.5 shrink-0"
					/>
					<span className="sr-only">
						<Trans>Suggested:</Trans>
					</span>
					<span className="wrap-anywhere">{card.explanation}</span>
				</p>
			) : null}

			{options.length > 0 ? (
				<RadioGroup
					value={optionId ?? ''}
					onValueChange={(value) => {
						setOptionId(String(value))
						setInput('')
					}}
					aria-label={_(t`Choose a fix`)}
				>
					{options.map((option) => (
						<ChoiceCard key={option.id}>
							<RadioGroupItem value={option.id} />
							<ChoiceCardContent>
								<ChoiceCardTitle>{optionLabel(_, option)}</ChoiceCardTitle>
							</ChoiceCardContent>
						</ChoiceCard>
					))}
				</RadioGroup>
			) : null}

			<MenuCardPreviewView preview={preview} />

			{inputKind ? (
				<CardInput kind={inputKind} value={input} onChange={setInput} />
			) : null}

			{warnings.length > 0 ? (
				<ul className="text-warning space-y-1 text-xs">
					{warnings.map((code) => (
						<li key={code} className="flex items-start gap-1.5">
							<Icon
								name="circle-alert"
								aria-hidden
								className="mt-0.5 size-3.5 shrink-0"
							/>
							<span>{_(WARNING_LABELS[code]!)}</span>
						</li>
					))}
				</ul>
			) : null}

			<CardReferences references={card.references} />

			<div className="flex flex-wrap justify-end gap-2">
				<CardSkipMenu disabled={busy} onChoose={onSkip} />
				<Button
					disabled={busy || !canAccept}
					onClick={() =>
						onAccept(optionId, inputKind ? input.trim() : undefined)
					}
				>
					<Trans>Accept</Trans>
				</Button>
			</div>
		</div>
	)
}

/** One queued card in select-several mode. */
export function MenuReviewCardRow({
	card,
	checked,
	onCheckedChange,
}: {
	card: MenuCard
	checked: boolean
	onCheckedChange: (checked: boolean) => void
}) {
	const { _ } = useLingui()
	const needsInput = cardNeedsInput(card)
	return (
		<ChoiceCard>
			<Checkbox
				checked={checked}
				onCheckedChange={(value) => onCheckedChange(Boolean(value))}
			/>
			<ChoiceCardContent>
				<ChoiceCardTitle>{cardKindTitle(_, card.kind)}</ChoiceCardTitle>
				<ChoiceCardDescription>{card.subject}</ChoiceCardDescription>
				{needsInput ? (
					<ChoiceCardDescription>
						<Trans>Needs a value. Accept it on its own.</Trans>
					</ChoiceCardDescription>
				) : null}
			</ChoiceCardContent>
		</ChoiceCard>
	)
}
