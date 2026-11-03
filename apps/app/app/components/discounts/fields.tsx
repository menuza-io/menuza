import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Checkbox } from '@repo/ui/checkbox'
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from '@repo/ui/field'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from '@repo/ui/input-group'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Switch } from '@repo/ui/switch'
import {
	type ComponentProps,
	createContext,
	type ReactNode,
	type Ref,
	useContext,
	useEffect,
	useId,
	useState,
} from 'react'
import {
	type EditorErrorCode,
	type EditorErrors,
	parseRangeCode,
} from '#app/utils/discounts/editor-model.ts'
import { numberText } from '#app/utils/discounts/labels.ts'
import {
	type DiscountLimit,
	DISCOUNTS_LIMIT,
	ORG_CODES_LIMIT,
} from '#app/utils/discounts/limits.ts'

/**
 * A field's error line. The kit's FieldError is an alert, but the error summary
 * above the form already raises the one alert for a failed save, so these stay
 * plain text that the field points to with aria-describedby.
 */
export function FieldErrorText(props: ComponentProps<typeof FieldError>) {
	return <FieldError {...props} role={undefined} />
}

/** DOM id for an editor field, so the error summary can focus it. */
export function fieldDomId(field: string): string {
	return `discount-${field.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

/** A numbered-less section card: title, one line of help, then its fields. */
export function EditorSection({
	id,
	title,
	description,
	children,
}: {
	id: string
	title: ReactNode
	description?: ReactNode
	children: ReactNode
}) {
	const titleId = `${id}-title`
	return (
		// The summary links and the error list move focus here, and the margin
		// keeps the title clear of the sticky header.
		<div id={id} tabIndex={-1} className="scroll-mt-24 rounded-xl outline-none">
			<Frame className="w-full" role="group" aria-labelledby={titleId}>
				<FrameHeader>
					<FrameTitle id={titleId} className="text-base">
						{title}
					</FrameTitle>
					{description ? (
						<FrameDescription>{description}</FrameDescription>
					) : null}
				</FrameHeader>
				<FramePanel className="flex flex-col gap-5">{children}</FramePanel>
			</Frame>
		</div>
	)
}

export type Choice<T extends string> = {
	value: T
	label: ReactNode
	description?: ReactNode
	disabled?: boolean
}

/** One choice out of a few, as radio cards that read and tab like radios. */
export function ChoiceGroup<T extends string>({
	field,
	legend,
	hint,
	error,
	value,
	onChange,
	choices,
	className,
	columns = 1,
}: {
	field: string
	legend: ReactNode
	hint?: ReactNode
	error?: string | null
	value: T
	onChange: (value: T) => void
	choices: readonly Choice<T>[]
	className?: string
	/** Two columns from the small breakpoint up, for a long list of choices. */
	columns?: 1 | 2
}) {
	const id = fieldDomId(field)
	return (
		<FieldSet
			id={id}
			tabIndex={-1}
			className={className}
			aria-describedby={
				[hint ? `${id}-hint` : null, error ? `${id}-error` : null]
					.filter(Boolean)
					.join(' ') || undefined
			}
		>
			{/* A legend sits outside the fieldset's flex gap, so it sets its own. */}
			<FieldLegend variant="label" className="mb-2">
				{legend}
			</FieldLegend>
			<RadioGroup
				value={value}
				onValueChange={(next) => onChange(next as T)}
				className={cn('gap-2', columns === 2 && 'sm:grid-cols-2')}
				aria-invalid={error ? true : undefined}
			>
				{choices.map((choice) => {
					const optionId = `${id}-${choice.value}`
					return (
						<ChoiceCard key={choice.value} htmlFor={optionId}>
							<RadioGroupItem
								id={optionId}
								value={choice.value}
								disabled={choice.disabled}
							/>
							<ChoiceCardContent>
								<ChoiceCardTitle>{choice.label}</ChoiceCardTitle>
								{choice.description ? (
									<ChoiceCardDescription>
										{choice.description}
									</ChoiceCardDescription>
								) : null}
							</ChoiceCardContent>
						</ChoiceCard>
					)
				})}
			</RadioGroup>
			{hint ? (
				<FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
			) : null}
			{error ? (
				<FieldErrorText id={`${id}-error`}>{error}</FieldErrorText>
			) : null}
		</FieldSet>
	)
}

/** A group of checkboxes (channels, order types, locations). */
export function CheckboxGroup<T extends string>({
	field,
	legend,
	hint,
	error,
	value,
	onChange,
	options,
	className,
}: {
	field: string
	legend: ReactNode
	hint?: ReactNode
	error?: string | null
	value: readonly T[]
	onChange: (value: T[]) => void
	options: readonly { value: T; label: ReactNode }[]
	className?: string
}) {
	const id = fieldDomId(field)
	return (
		<FieldSet
			id={id}
			tabIndex={-1}
			className={className}
			aria-describedby={
				[hint ? `${id}-hint` : null, error ? `${id}-error` : null]
					.filter(Boolean)
					.join(' ') || undefined
			}
		>
			{/* A legend sits outside the fieldset's flex gap, so it sets its own. */}
			<FieldLegend variant="label" className="mb-2">
				{legend}
			</FieldLegend>
			{/* The slot gives it the kit's group spacing, like a radio group. */}
			<div
				data-slot="checkbox-group"
				className="flex flex-wrap gap-x-5 gap-y-2"
			>
				{options.map((option) => {
					const optionId = `${id}-${option.value}`
					const checked = value.includes(option.value)
					return (
						<div key={option.value} className="flex items-center gap-2">
							<Checkbox
								id={optionId}
								checked={checked}
								aria-invalid={error ? true : undefined}
								onCheckedChange={(next) =>
									onChange(
										next
											? [...value, option.value]
											: value.filter((current) => current !== option.value),
									)
								}
							/>
							<Label htmlFor={optionId} className="cursor-pointer font-normal">
								{option.label}
							</Label>
						</div>
					)
				})}
			</div>
			{hint ? (
				<FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
			) : null}
			{error ? (
				<FieldErrorText id={`${id}-error`}>{error}</FieldErrorText>
			) : null}
		</FieldSet>
	)
}

/** A labelled on/off row with a short explanation. */
export function SwitchRow({
	label,
	description,
	checked,
	onCheckedChange,
	disabled,
	badge,
	name,
}: {
	label: ReactNode
	description?: ReactNode
	checked: boolean
	onCheckedChange: (checked: boolean) => void
	disabled?: boolean
	badge?: ReactNode
	name?: string
}) {
	const id = useId()
	return (
		<div className="flex items-start justify-between gap-4">
			<Label
				htmlFor={id}
				className={cn(
					'min-w-0 flex-1 flex-col items-start gap-0.5 font-normal',
					disabled ? 'cursor-not-allowed' : 'cursor-pointer',
				)}
			>
				<span className="flex flex-wrap items-center gap-2 text-sm font-medium">
					{label}
					{badge}
				</span>
				{description ? (
					<span className="text-muted-foreground text-sm">{description}</span>
				) : null}
			</Label>
			<Switch
				id={id}
				name={name}
				checked={checked}
				disabled={disabled}
				onCheckedChange={onCheckedChange}
				className="mt-0.5 shrink-0"
			/>
		</div>
	)
}

/** Fields that only make sense when something above them is on. */
export function Indented({ children }: { children: ReactNode }) {
	return (
		<div className="border-border flex flex-col gap-4 border-s-2 ps-4">
			{children}
		</div>
	)
}

/**
 * Optional settings folded under one row, so a section shows what most
 * discounts need first. It opens by itself when something inside is set or
 * has an error, so nothing chosen is ever hidden.
 */
export function OptionalGroup({
	label,
	description,
	chosen,
	hasError = false,
	children,
}: {
	label: ReactNode
	description?: ReactNode
	/** One entry per thing set inside; the row shows how many. */
	chosen: readonly unknown[]
	hasError?: boolean
	children: ReactNode
}) {
	const panelId = useId()
	const [open, setOpen] = useState(chosen.length > 0 || hasError)
	// A failed save points at fields in here: show them.
	useEffect(() => {
		if (hasError) setOpen(true)
	}, [hasError])
	return (
		<div className="flex flex-col gap-4">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => setOpen((current) => !current)}
				className="group/optional hover:bg-muted/60 focus-visible:ring-ring/50 -mx-2 -my-1.5 flex items-start justify-between gap-4 rounded-md px-2 py-1.5 text-start transition-colors outline-none focus-visible:ring-2"
			>
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="flex flex-wrap items-center gap-2 text-sm font-medium">
						{label}
						{chosen.length > 0 ? (
							<Badge variant="secondary">
								<Plural value={chosen.length} one="# chosen" other="# chosen" />
							</Badge>
						) : null}
					</span>
					{description ? (
						<span className="text-muted-foreground text-sm">{description}</span>
					) : null}
				</span>
				<Icon
					name="chevron-down"
					aria-hidden
					className={cn(
						'text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
						open && 'rotate-180',
					)}
				/>
			</button>
			<div id={panelId} hidden={!open}>
				<Indented>{children}</Indented>
			</div>
		</div>
	)
}

/**
 * The currency the editor's amounts are in, for the messages that name it. The
 * form provides it; an error line outside the form has none.
 */
export const EditorCurrencyContext = createContext('')

/** The message for an organization-wide cap the region refused. */
export function useLimitText(): (limit: DiscountLimit) => string {
	const { t, i18n } = useLingui()
	return (limit) => {
		if (limit === 'discounts') {
			const count = numberText(DISCOUNTS_LIMIT, i18n.locale)
			return t`You have reached the limit of ${count} discounts. Archive some you no longer use.`
		}
		const count = numberText(ORG_CODES_LIMIT, i18n.locale)
		return t`You have reached the limit of ${count} coupon codes across all discounts.`
	}
}

/** A refused save, restore or duplicate that hit an organization-wide cap. */
export function LimitNotice({
	limit,
	className,
	ref,
}: {
	limit: DiscountLimit
	className?: string
	ref?: Ref<HTMLParagraphElement>
}) {
	const limitText = useLimitText()
	return (
		<p
			ref={ref}
			role="alert"
			tabIndex={-1}
			className={cn('text-destructive text-sm outline-none', className)}
		>
			{limitText(limit)}
		</p>
	)
}

export function useEditorErrorText(
	/** For the form itself, which sits outside its own provider. */
	currencyOverride?: string,
): (code: EditorErrorCode) => string {
	const { t } = useLingui()
	const contextCurrency = useContext(EditorCurrencyContext)
	const currency = currencyOverride ?? contextCurrency
	const limitText = useLimitText()
	return (code) => {
		const range = parseRangeCode(code)
		if (range) {
			const { min, max } = range
			return t`Enter a whole number from ${min} to ${max}.`
		}
		switch (code) {
			case 'required':
				return t`Enter a value.`
			case 'default_language_required':
				return t`Enter it in your website's default language too. Other languages fall back to it.`
			case 'too_long':
				return t`That is too long.`
			case 'percent':
				return t`Enter a percentage from 0.01 to 100.`
			case 'amount':
				return t`Enter an amount above zero, such as 5.00.`
			case 'number':
				return t`Enter a whole number.`
			case 'choose_items':
				return t`Choose at least one item.`
			case 'choose_categories':
				return t`Choose at least one category.`
			case 'choose_one':
				return t`Choose at least one.`
			case 'location_scope':
				return t`Pick only locations you manage.`
			case 'date':
				return t`Pick a valid date and time.`
			case 'end_before_start':
				return t`The end has to come after the start.`
			case 'time':
				return t`Enter a time such as 14:30.`
			case 'same_time':
				return t`Start and end have to be different times.`
			case 'add_hours':
				return t`Add at least one set of hours, or turn weekly hours off.`
			case 'code_format':
				return t`Use 3 to 24 letters, numbers or dashes.`
			case 'code_duplicate':
				return t`This code is listed twice.`
			case 'code_taken':
				return t`Another discount already uses this code.`
			case 'too_many_codes':
				return t`A discount can have up to 90 codes. Make another discount for more.`
			case 'org_codes_limit':
				return limitText('codes')
			case 'amounts_unavailable':
				return currency
					? t`Amounts off aren't available yet for ${currency}; use a percentage.`
					: t`Amounts off aren't available yet for this currency; use a percentage.`
			case 'limits_unavailable':
				return currency
					? t`Amounts of money aren't available yet for ${currency}. Clear this field.`
					: t`Amounts of money aren't available yet for this currency. Clear this field.`
			case 'mixed_currencies':
				return t`Your locations use different currencies. Choose locations that share one currency to set an amount.`
			case 'needs_delivery':
				return t`Free delivery needs the Delivery order type.`
			case 'add_tier':
				return t`Add at least one tier.`
			case 'tiers_ascending':
				return t`Each tier has to be higher than the one before.`
			case 'choose_modifiers':
				return t`Choose at least one modifier group or option.`
			case 'bundle_too_big':
				return t`A deal holds at most 20 items. Lower a quantity or remove a group.`
			case 'set_price_needs_items':
				return t`A set price needs specific items or categories, or a meal deal.`
			case 'set_price_quantity':
				return t`A set price applies to every matching item. Choose "Every qualifying item", or use a meal deal.`
			case 'bogo_needs_items':
				return t`Buy some, discount some needs specific items or categories. Choose them under Applies to.`
			case 'too_many_windows':
				return t`Weekly hours can have up to 28 windows. Remove some, or combine days that share the same hours.`
			case 'too_many_items':
				return t`You can choose up to 200 items here. Choose a category instead.`
			case 'too_many_categories':
				return t`You can choose up to 100 categories here.`
			case 'too_many_modifiers':
				return t`You can choose up to 50 modifier groups and 200 modifier options.`
			case 'too_many_variants':
				return t`You can choose up to 3 option types, with up to 50 options each.`
			case 'application_off':
				return t`This way of applying is switched off for your organization. Choose another.`
			case 'invalid':
				return t`Check this setting.`
		}
		return t`Check this setting.`
	}
}

/**
 * "12 of 75". Each number sits in its own <bdi>, so the digits keep their order
 * while the translated "of" and the sentence around them follow the page
 * direction.
 */
export function Counter({ value, max }: { value: number; max: number }) {
	return (
		<span className="tabular-nums">
			<Trans>
				<bdi>{value}</bdi> of <bdi>{max}</bdi>
			</Trans>
		</span>
	)
}

/**
 * The label of a field in a repeated row. A screen reader hears `full`, which
 * says which row it is ("Code 2"). `short` is what a sighted person sees, or
 * nothing when only the first row shows its column names.
 */
export function RowLabel({
	short,
	full,
	visible = true,
}: {
	short: ReactNode
	full: ReactNode
	visible?: boolean
}) {
	return (
		<>
			{visible ? <span aria-hidden>{short}</span> : null}
			<span className="sr-only">{full}</span>
		</>
	)
}

/** A labelled text input with an optional suffix, hint and error. */
export function TextField({
	field,
	label,
	hint,
	value,
	error,
	onChange,
	type = 'text',
	inputMode,
	maxLength,
	suffix,
	disabled,
	autoComplete,
	className,
	width = 'full',
}: {
	field: string
	label: ReactNode
	hint?: ReactNode
	value: string
	error?: EditorErrors[string]
	onChange: (value: string) => void
	type?: string
	inputMode?: 'decimal' | 'numeric' | 'text'
	maxLength?: number
	/** A unit shown inside the input, such as "%" or a currency code. */
	suffix?: string
	disabled?: boolean
	autoComplete?: string
	className?: string
	/**
	 * How wide the input is from the small breakpoint up: `short` for a count,
	 * `medium` for an amount of money. The label and hint keep the full width.
	 */
	width?: 'full' | 'medium' | 'short'
}) {
	const errorText = useEditorErrorText()
	const id = fieldDomId(field)
	return (
		<Field className={className}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<InputGroup
				className={cn(
					width === 'short' && 'sm:max-w-36',
					width === 'medium' && 'sm:max-w-56',
				)}
			>
				<InputGroupInput
					id={id}
					type={type}
					inputMode={inputMode}
					value={value}
					maxLength={maxLength}
					disabled={disabled}
					autoComplete={autoComplete}
					aria-invalid={error ? true : undefined}
					aria-describedby={
						[hint ? `${id}-hint` : null, error ? `${id}-error` : null]
							.filter(Boolean)
							.join(' ') || undefined
					}
					onChange={(event) => onChange(event.currentTarget.value)}
				/>
				{suffix ? (
					<InputGroupAddon align="inline-end">
						<bdi>{suffix}</bdi>
					</InputGroupAddon>
				) : null}
			</InputGroup>
			{hint ? (
				<FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
			) : null}
			{error ? (
				<FieldErrorText id={`${id}-error`}>{errorText(error)}</FieldErrorText>
			) : null}
		</Field>
	)
}
