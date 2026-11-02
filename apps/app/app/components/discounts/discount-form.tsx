import { Trans, useLingui } from '@lingui/react/macro'
import { type SiteLocalesConfig } from '@repo/common/site-locales'
import {
	DISCOUNT_COMBINE_CLASS_VALUES,
	DISCOUNT_DESCRIPTION_MAX,
	DISCOUNT_NAME_MAX,
	DISCOUNT_TOTAL_LIMIT_PRESETS,
	type DiscountValueType,
} from '@repo/discounts'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Field, FieldDescription, FieldLabel } from '@repo/ui/field'
import {
	type ComponentProps,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from 'react'
import { Form, useSearchParams } from 'react-router'
import { CatalogPicker } from '#app/components/loyalty/catalog-picker.tsx'
import { MenuFormHeader } from '#app/components/menu/menu-form-header.tsx'
import {
	ALL_CHANNELS,
	ALL_FULFILLMENTS,
	type DiscountChoiceCatalog,
	type EditorErrors,
	type EditorState,
	type DiscountLocationChoice,
	amountsSupported,
	promoteOnMenuAllowed,
	resolveDiscountCurrency,
	stateUsesAmounts,
	tiersApply,
} from '#app/utils/discounts/editor-model.ts'
import { type DiscountHistoryEntry } from '#app/utils/discounts/history.server.ts'
import {
	DISCOUNT_CHANNEL_LABELS,
	DISCOUNT_COMBINE_LABELS,
	DISCOUNT_ELIGIBILITY_LABELS,
	DISCOUNT_FULFILLMENT_LABELS,
	DISCOUNT_PERIOD_LABELS,
	DISCOUNT_STATUS_LABELS,
	DISCOUNT_VALUE_TYPE_LABELS,
} from '#app/utils/discounts/labels.ts'
import { type DiscountLimit } from '#app/utils/discounts/limits.ts'
import { type LoyaltyCatalog } from '#app/utils/loyalty/catalog.ts'
import { formatInstantDate } from '#app/utils/people/people-view.ts'
import { defaultEntry } from '#app/utils/reservations/localized.ts'
import { CodesEditor } from './codes-editor.tsx'
import { BuyGetGroups, DealSlots } from './deal-groups.tsx'
import { DiscountHistory } from './discount-history.tsx'
import { DiscountSummary } from './discount-summary.tsx'
import {
	type Choice,
	CheckboxGroup,
	ChoiceGroup,
	Counter,
	EditorCurrencyContext,
	EditorSection,
	FieldErrorText,
	Indented,
	LimitNotice,
	SwitchRow,
	TextField,
	fieldDomId,
	useEditorErrorText,
} from './fields.tsx'
import {
	ContentLocaleProvider,
	LocalizedMapInput,
	LocalizedMapTextarea,
	useActiveLocale,
	WritingLanguageNote,
} from './localized-fields.tsx'
import { TierSteps } from './tier-steps.tsx'
import { VariantFilter } from './variant-filter.tsx'
import { WeeklyHours } from './weekly-hours.tsx'

const DESCRIPTION_MAX = DISCOUNT_DESCRIPTION_MAX

/** The values that are an amount of money. */
const AMOUNT_VALUE_TYPES: ReadonlySet<DiscountValueType> =
	new Set<DiscountValueType>(['fixed', 'fixed_price', 'variable_amount'])

/**
 * The line that says why the status buttons are off while there are unsaved
 * edits. The buttons point at it with `aria-describedby`.
 */
export const UNSAVED_CHANGES_NOTE_ID = 'discount-unsaved-note'

/**
 * The guest-facing name and description are written in each website language
 * (Website settings), the way Reservations and Menu text is: the header's
 * switcher picks the language being written, and shows only when there are
 * several.
 */
export function DiscountForm(props: ComponentProps<typeof DiscountFormBody>) {
	return (
		<ContentLocaleProvider config={props.siteLocales}>
			<DiscountFormBody {...props} />
		</ContentLocaleProvider>
	)
}

/** One line under each discount value, so the names don't have to explain it. */
function valueDescription(value: DiscountValueType): ReactNode {
	switch (value) {
		case 'percent':
			return <Trans>Takes a percentage off.</Trans>
		case 'fixed':
			return <Trans>Takes a fixed amount off.</Trans>
		case 'fixed_price':
			return <Trans>The items cost a flat price instead.</Trans>
		case 'free_delivery':
			return <Trans>Takes the delivery fee off.</Trans>
		default:
			return undefined
	}
}

/**
 * The quantity rules, each with a line saying what it is for. A rule that
 * can't go with the chosen discount stays visible but says why it is off.
 */
function quantityChoices(
	state: Pick<EditorState, 'application' | 'valueType' | 'scope'> & {
		/** Tiers are on: a quantity rule would silently turn them off. */
		tierLock: boolean
	},
): Choice<EditorState['quantityKind']>[] {
	if (state.scope === 'modifiers') {
		// Choices on an item aren't counted like items: all of them, or the
		// first few on each item.
		return [
			{
				value: 'none',
				label: <Trans>Every matching choice</Trans>,
				description: <Trans>Every choice you picked gets the discount.</Trans>,
			},
			{
				value: 'per_item',
				label: <Trans>The first few on each item</Trans>,
				description: (
					<Trans>
						The most expensive choices on each item, such as 2 toppings free.
					</Trans>
				),
			},
		]
	}
	const setPrice = state.valueType === 'fixed_price'
	const atTill = state.application === 'manual'
	const { tierLock } = state
	const countedOff = <Trans>Not available with a set price.</Trans>
	const tiersOff = (
		<Trans>Not available with tiers. Turn tiers off first.</Trans>
	)
	return [
		{
			value: 'none',
			label: <Trans>Every qualifying item</Trans>,
			description: <Trans>Every matching item gets the discount.</Trans>,
		},
		{
			value: 'minimum',
			label: <Trans>At least a quantity</Trans>,
			description: setPrice ? (
				countedOff
			) : tierLock ? (
				tiersOff
			) : (
				<Trans>
					Only when the order has at least this many matching items.
				</Trans>
			),
			disabled: setPrice || tierLock,
		},
		{
			value: 'exact',
			label: <Trans>Groups of a quantity</Trans>,
			description: setPrice ? (
				countedOff
			) : tierLock ? (
				tiersOff
			) : (
				<Trans>Each full group of a set size, such as every pair.</Trans>
			),
			disabled: setPrice || tierLock,
		},
		{
			value: 'bogo',
			label: <Trans>Buy some, discount some</Trans>,
			description: setPrice ? (
				countedOff
			) : tierLock ? (
				tiersOff
			) : state.scope === 'order' ? (
				<Trans>
					Needs specific items or categories. Choose them under Applies to.
				</Trans>
			) : (
				<Trans>
					Buy some of the matching items, then discount the next ones.
				</Trans>
			),
			disabled: setPrice || tierLock || state.scope === 'order',
		},
		{
			value: 'buy_get',
			label: <Trans>Buy one group, discount another</Trans>,
			description: atTill ? (
				<Trans>Not available at the till.</Trans>
			) : tierLock ? (
				tiersOff
			) : (
				<Trans>Buy a burger, get fries free.</Trans>
			),
			disabled: atTill || tierLock,
		},
		{
			value: 'bundle',
			label: <Trans>Meal deal</Trans>,
			description: atTill ? (
				<Trans>Not available at the till.</Trans>
			) : tierLock ? (
				tiersOff
			) : (
				<Trans>Items sold together, such as a pizza, a side and a drink.</Trans>
			),
			disabled: atTill || tierLock,
		},
	]
}

/**
 * The line under the amount field. It opens with the unit as its own short
 * sentence ("Amount in USD."), so the code is never a fragment that a
 * right-to-left sentence turns into ".USD". The code sits in <bdi> so it keeps
 * its letters in order.
 */
function amountHint({
	valueType,
	quantityKind,
	scope,
	amountPerItem,
	currency,
}: {
	valueType: DiscountValueType
	quantityKind: EditorState['quantityKind']
	scope: EditorState['scope']
	amountPerItem: boolean
	currency: string
}): ReactNode {
	if (valueType === 'fixed_price') {
		if (quantityKind === 'bundle') {
			return (
				<Trans>
					Amount in <bdi>{currency}</bdi>. Each deal costs this price.
				</Trans>
			)
		}
		if (quantityKind === 'buy_get') {
			return (
				<Trans>
					Amount in <bdi>{currency}</bdi>. Each item the customer gets costs
					this price.
				</Trans>
			)
		}
		if (scope === 'modifiers') {
			return (
				<Trans>
					Amount in <bdi>{currency}</bdi>. Each choice costs this price.
				</Trans>
			)
		}
		return (
			<Trans>
				Amount in <bdi>{currency}</bdi>. Each matching item costs this price.
			</Trans>
		)
	}
	if (quantityKind === 'buy_get') {
		return (
			<Trans>
				Amount in <bdi>{currency}</bdi>. Taken off each item the customer gets.
			</Trans>
		)
	}
	if (quantityKind === 'bundle') {
		return (
			<Trans>
				Amount in <bdi>{currency}</bdi>. Taken off each deal.
			</Trans>
		)
	}
	if (amountPerItem) {
		return scope === 'modifiers' ? (
			<Trans>
				Amount in <bdi>{currency}</bdi>. Taken off each matching choice.
			</Trans>
		) : (
			<Trans>
				Amount in <bdi>{currency}</bdi>. Taken off each matching item.
			</Trans>
		)
	}
	return (
		<Trans>
			Amount in <bdi>{currency}</bdi>. Taken off the order once.
		</Trans>
	)
}

function DiscountFormBody({
	orgSlug,
	mode,
	currency: fallbackCurrency,
	features,
	catalog,
	locations,
	choices,
	siteLocales,
	initial,
	version,
	status,
	canWrite,
	errors,
	stale,
	keepEdits = false,
	formError,
	limit = null,
	isSubmitting,
	statusActions,
	createdBy = null,
	history = [],
	createdAt = null,
	sharedWithOtherLocations = false,
}: {
	orgSlug: string
	mode: 'new' | 'edit'
	/** Used when no location says a currency; otherwise the locations decide. */
	currency: string
	features: { automatic: boolean; coupons: boolean }
	catalog: LoyaltyCatalog
	locations: DiscountLocationChoice[]
	choices: DiscountChoiceCatalog
	/** The website's languages: the name and description are written in each. */
	siteLocales: SiteLocalesConfig
	initial: EditorState
	version: number | null
	status: 'active' | 'paused' | 'archived'
	canWrite: boolean
	errors: EditorErrors
	stale: boolean
	/** A stale save: the form keeps the operator's edits (see the route). */
	keepEdits?: boolean
	formError: boolean
	/** The save, restore or duplicate ran into an organization-wide cap. */
	limit?: DiscountLimit | null
	isSubmitting: boolean
	/** Pause, restore, archive and duplicate. They act on the saved discount. */
	statusActions?: (context: { dirty: boolean }) => ReactNode
	createdBy?: { name: string } | null
	history?: readonly DiscountHistoryEntry[]
	createdAt?: string | null
	/**
	 * The member may change discounts but this one also runs at locations
	 * outside theirs, so it is read-only for them (`discountEditableInScope`).
	 */
	sharedWithOtherLocations?: boolean
}) {
	const { t, i18n } = useLingui()
	const { activeLocale } = useActiveLocale()
	const [state, setState] = useState(initial)
	// What the form held when it opened: the edits are the difference.
	const [baseline] = useState(() => JSON.stringify(initial))
	const dirty = JSON.stringify(state) !== baseline
	const [params] = useSearchParams()
	const savedParam = params.get('saved') === '1'
	const editable = canWrite && status !== 'archived'
	const patch = (next: Partial<EditorState>) =>
		setState((current) => ({ ...current, ...next }))
	const backHref = `/${orgSlug}/discounts`
	const createdAtLabel =
		mode === 'edit' && createdAt
			? formatInstantDate(new Date(createdAt).getTime(), i18n.locale)
			: null
	const freeDelivery = state.valueType === 'free_delivery'
	// These two rules choose their own items, so the Applies to choice steps aside.
	const setRule =
		!freeDelivery &&
		(state.quantityKind === 'buy_get' || state.quantityKind === 'bundle')
	const itemScope = !freeDelivery && (setRule || state.scope !== 'order')
	// A ladder replaces the single value on a plain item or order discount.
	const tiered = tiersApply(state)
	const canTier = tiersApply({ ...state, tiersOn: true })
	const percentOrAmount =
		state.valueType === 'percent' || state.valueType === 'fixed'
	// With tiers on, anything that turns them off is greyed out and says why.
	const tierLock = state.tiersOn && percentOrAmount
	// A fixed amount comes off each matching item on an item discount.
	const amountPerItem = !freeDelivery && !setRule && state.scope !== 'order'

	// Amounts are in the currency of the locations the discount applies to.
	// With several currencies among them none can be named: the operator has to
	// choose locations that share one before setting an amount.
	const resolved = resolveDiscountCurrency(state, locations, fallbackCurrency)
	const mixedCurrencies = resolved.mixed
	const amountsCurrency = resolved.currency ?? fallbackCurrency
	const mixedCurrencyNotice = mixedCurrencies && stateUsesAmounts(state)
	// What the hints call the currency. In a mix there is none to name yet.
	const currency = mixedCurrencies
		? t`the currency of your locations`
		: amountsCurrency
	// Orders can't count money in this currency yet, so only percentages work.
	const noAmounts = !amountsSupported(amountsCurrency)
	// This sits outside the provider below, so it is given the currency itself.
	const errorText = useEditorErrorText(amountsCurrency)
	const errorKey = Object.keys(errors).join('\n')
	const hasErrors = errorKey.length > 0
	// "Saved." is about the last save: an error or a new edit makes it stale.
	const saved =
		savedParam && !dirty && !hasErrors && !stale && !formError && !limit
	const pickError = (field: string) =>
		errors[field] ? errorText(errors[field]!) : null
	/** The element an error belongs to: its own id, else the nearest section. */
	const errorTarget = (field: string): HTMLElement | null => {
		const parts = field.split('.')
		for (let size = parts.length; size > 0; size -= 1) {
			const node = document.getElementById(
				fieldDomId(parts.slice(0, size).join('.')),
			)
			if (node) return node
		}
		return document.getElementById('discount-section-basics')
	}
	/** The name of the field an error is on, as the form words it. */
	const fieldLabel = (field: string): string | null => {
		const head = field.split('.')[0]!
		switch (head) {
			case 'name':
				return t`Name`
			case 'internalName':
				return t`Internal name`
			case 'description':
				return t`Description`
			case 'application':
				return t`How it applies`
			case 'valueType':
				return t`Discount`
			case 'percent':
				return t`Percent off`
			case 'amount':
				return state.valueType === 'fixed_price' ? t`Set price` : t`Amount off`
			case 'maxDiscount':
				return t`Maximum off`
			case 'minSubtotal':
				return t`Minimum spend`
			case 'target':
				return t`Applies to`
			case 'variants':
			case 'modifier-variants':
				return t`Only these options`
			case 'modifier-options':
				return t`Modifier options`
			case 'modifier-items':
				return t`Only on these items`
			case 'modifier-categories':
				return t`Only in these categories`
			case 'exclude-items':
				return t`Exclude items`
			case 'exclude-categories':
				return t`Exclude categories`
			case 'requireQuantity':
				return t`Quantity required`
			case 'requirement':
				return t`Required items`
			case 'require-categories':
				return t`Required categories`
			case 'quantityKind':
				return t`Quantity rule`
			case 'quantityN':
				return t`Quantity`
			case 'perItemN':
				return t`Choices per item`
			case 'buyQuantity':
				return t`Buy quantity`
			case 'getQuantity':
				return t`Discounted quantity`
			case 'maxUnits':
				return t`Items discounted per use`
			case 'tiers':
				return t`Tiers`
			case 'maxDeliveryFee':
				return t`Largest fee to waive`
			case 'combinesWith':
				return t`Can combine with`
			case 'buyGroup':
				return t`Customer buys`
			case 'getGroup':
				return t`Customer gets`
			case 'slots':
				return t`Meal deal groups`
			case 'schedule':
				return t`Weekly hours`
			case 'startsAt':
				return t`Starts`
			case 'endsAt':
				return t`Ends`
			case 'codes':
				return t`Codes`
			case 'locations':
				return t`Locations`
			case 'channels':
				return t`Channels`
			case 'fulfillments':
				return t`Order types`
			case 'totalLimit':
				return t`Maximum uses`
			case 'totalLimitCustom':
				return t`Custom maximum`
			case 'perCustomerCount':
				return t`Uses allowed`
			case 'priority':
				return t`Priority`
			default:
				return null
		}
	}
	/** "Name: Enter a value." The punctuation is part of the message, so a language can set it its own way. */
	const errorLine = (field: string): string => {
		const label = fieldLabel(field)
		const message = errorText(errors[field]!)
		return label ? t`${label}: ${message}` : message
	}
	// `errors` is a new object for every response, so sending the same mistakes
	// again moves focus back to the first one instead of doing nothing.
	// One alert speaks for a failed save, and focus goes to it: the summary when
	// fields are wrong (its links lead to each field), the plain message when
	// the save failed for another reason.
	const summaryRef = useRef<HTMLDivElement>(null)
	const formErrorRef = useRef<HTMLParagraphElement>(null)
	const limitRef = useRef<HTMLParagraphElement>(null)
	useEffect(() => {
		if (Object.keys(errors).length === 0) return
		summaryRef.current?.focus()
		summaryRef.current?.scrollIntoView({ block: 'nearest' })
	}, [errors])
	useEffect(() => {
		if (isSubmitting || !formError || hasErrors) return
		formErrorRef.current?.focus()
		formErrorRef.current?.scrollIntoView({ block: 'nearest' })
	}, [isSubmitting, formError, hasErrors])
	useEffect(() => {
		if (isSubmitting || !limit || hasErrors) return
		limitRef.current?.focus()
		limitRef.current?.scrollIntoView({ block: 'nearest' })
	}, [isSubmitting, limit, hasErrors])

	return (
		<EditorCurrencyContext.Provider value={amountsCurrency}>
			<Form method="post" className="min-h-full">
				<input type="hidden" name="intent" value="save" />
				<input type="hidden" name="status" value={status} />
				{version !== null ? (
					<input type="hidden" name="expectedVersion" value={String(version)} />
				) : null}
				<input type="hidden" name="state" value={JSON.stringify(state)} />

				<MenuFormHeader
					pageTitle={
						mode === 'new' ? (
							<Trans>New discount</Trans>
						) : (
							defaultEntry(state.name, siteLocales) || t`Discount`
						)
					}
					backHref={backHref}
					backLabel={t`Back to discounts`}
					saveButtonText={
						mode === 'new' ? t`Create discount` : t`Save discount`
					}
					isSubmitting={isSubmitting}
					saveDisabled={!editable}
					showCancel
					titleAccessory={
						mode === 'edit' ? (
							<Badge
								variant={
									status === 'active'
										? 'success'
										: status === 'paused'
											? 'warning'
											: 'secondary'
								}
							>
								{i18n._(DISCOUNT_STATUS_LABELS[status])}
							</Badge>
						) : undefined
					}
					secondaryAction={statusActions?.({ dirty })}
				/>

				{mode === 'edit' && createdBy ? (
					<p className="text-muted-foreground border-border mx-auto w-full max-w-6xl border-b px-4 py-1.5 text-xs md:px-6 lg:px-8">
						<Trans>Created by {createdBy.name}</Trans>
						{createdAtLabel ? (
							<>
								<span aria-hidden="true"> · </span>
								<span>{createdAtLabel}</span>
							</>
						) : null}
					</p>
				) : null}
				{mode === 'edit' ? <DiscountHistory entries={history} /> : null}

				<div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 px-4 py-6 md:px-6 lg:grid-cols-12 lg:px-8">
					<fieldset
						disabled={!editable}
						className="flex min-w-0 flex-col gap-6 border-0 p-0 disabled:opacity-80 lg:col-span-8"
					>
						{saved ? (
							<p
								role="status"
								className="bg-primary/10 text-foreground rounded-lg px-3 py-2 text-sm"
							>
								<Trans>Saved.</Trans>
							</p>
						) : null}
						{stale ? (
							<p role="alert" className="text-destructive text-sm">
								{keepEdits ? (
									<Trans>
										Someone else saved this discount while you were editing.
										Your changes are still here. Saving again replaces their
										version.
									</Trans>
								) : (
									<Trans>
										Someone else changed this discount. This page now shows
										their version. Try again.
									</Trans>
								)}
							</p>
						) : null}
						{mode === 'edit' && status === 'paused' ? (
							<p className="text-muted-foreground text-sm">
								<Trans>
									This discount is paused. Customers can't get it until you
									resume it.
								</Trans>
							</p>
						) : null}
						{mode === 'edit' && status === 'archived' ? (
							<p role="status" className="text-muted-foreground text-sm">
								<Trans>
									This discount is archived, so it can't be edited. Restore it
									to change it. It comes back paused.
								</Trans>{' '}
								{state.application === 'code' ? (
									<Trans>
										Its coupon codes are not brought back: add new ones before
										you turn it on.
									</Trans>
								) : null}
							</p>
						) : null}
						{editable && dirty && statusActions ? (
							<p
								id={UNSAVED_CHANGES_NOTE_ID}
								role="status"
								className="text-muted-foreground text-sm"
							>
								<Trans>
									You have unsaved changes. Save or discard them first: Pause,
									Restore, Archive, Duplicate and Print coupons use the saved
									discount.
								</Trans>
							</p>
						) : null}
						{limit && !hasErrors ? (
							<LimitNotice ref={limitRef} limit={limit} />
						) : null}
						{formError && !hasErrors ? (
							<p
								ref={formErrorRef}
								role="alert"
								tabIndex={-1}
								className="text-destructive text-sm outline-none"
							>
								<Trans>
									This discount could not be saved. Check the fields and try
									again.
								</Trans>
							</p>
						) : null}
						{!canWrite ? (
							<p className="text-muted-foreground text-sm">
								{sharedWithOtherLocations ? (
									<Trans>
										This discount also runs at locations outside yours, so you
										can look at it but not change it. Ask someone who manages
										every location.
									</Trans>
								) : (
									<Trans>
										You can look at this discount. You don't have permission to
										change it.
									</Trans>
								)}
							</p>
						) : null}
						{hasErrors ? (
							<div
								ref={summaryRef}
								id="discount-error-summary"
								role="alert"
								tabIndex={-1}
								aria-labelledby="discount-error-summary-title"
								className="border-destructive/40 bg-destructive/5 rounded-lg border px-3 py-3 outline-none"
							>
								<p
									id="discount-error-summary-title"
									className="text-sm font-medium"
								>
									<Trans>Fix these before saving.</Trans>
								</p>
								<ul className="mt-2 flex flex-col gap-1">
									{errorKey.split('\n').map((field) => (
										<li key={field}>
											<a
												href={`#${fieldDomId(field)}`}
												className="text-destructive text-sm underline underline-offset-4"
												onClick={(event) => {
													event.preventDefault()
													errorTarget(field)?.focus()
												}}
											>
												{errorLine(field)}
											</a>
										</li>
									))}
								</ul>
							</div>
						) : null}

						<EditorSection
							id="discount-section-basics"
							title={<Trans>Basics</Trans>}
							description={
								<Trans>
									The name customers see, and how the discount is taken off.
								</Trans>
							}
						>
							<Field>
								<FieldLabel htmlFor={fieldDomId('name')}>
									<Trans>Name</Trans>
								</FieldLabel>
								<LocalizedMapInput
									id={fieldDomId('name')}
									value={state.name}
									maxLength={DISCOUNT_NAME_MAX}
									autoComplete="off"
									aria-invalid={errors.name ? true : undefined}
									aria-describedby={
										errors.name ? `${fieldDomId('name')}-error` : undefined
									}
									onChange={(name) => patch({ name })}
								/>
								{errors.name ? (
									<FieldErrorText id={`${fieldDomId('name')}-error`}>
										{errorText(errors.name)}
									</FieldErrorText>
								) : null}
							</Field>
							<TextField
								field="internalName"
								label={<Trans>Internal name</Trans>}
								hint={
									<Trans>
										Optional. Shown to your team instead of the customer name.
									</Trans>
								}
								value={state.internalName}
								maxLength={DISCOUNT_NAME_MAX}
								error={errors.internalName}
								onChange={(internalName) => patch({ internalName })}
							/>
							<Field>
								<div className="flex items-baseline justify-between gap-3">
									<FieldLabel htmlFor={fieldDomId('description')}>
										<Trans>Description</Trans>
									</FieldLabel>
									<FieldDescription>
										<Counter
											value={state.description[activeLocale]?.length ?? 0}
											max={DESCRIPTION_MAX}
										/>
									</FieldDescription>
								</div>
								<LocalizedMapTextarea
									id={fieldDomId('description')}
									value={state.description}
									maxLength={DESCRIPTION_MAX}
									rows={2}
									aria-invalid={errors.description ? true : undefined}
									aria-describedby={
										errors.description
											? `${fieldDomId('description')}-error`
											: undefined
									}
									onChange={(description) => patch({ description })}
								/>
								{errors.description ? (
									<FieldErrorText id={`${fieldDomId('description')}-error`}>
										{errorText(errors.description)}
									</FieldErrorText>
								) : null}
							</Field>
							<WritingLanguageNote />
							<ChoiceGroup
								field="application"
								legend={<Trans>How it applies</Trans>}
								value={state.application}
								error={
									errors.application ? errorText(errors.application) : null
								}
								onChange={(application) => {
									if (
										state.application === 'code' &&
										application !== 'code' &&
										state.codes.some((row) => row.code.trim())
									) {
										const ok = window.confirm(
											t`Switching away from Coupon code archives every code when you save, and the discount applies automatically to qualifying orders. Continue?`,
										)
										if (!ok) return
									}
									patch({
										application,
										...(application !== 'manual' &&
										(state.valueType === 'variable_percent' ||
											state.valueType === 'variable_amount')
											? { valueType: 'percent' as const }
											: {}),
										// A set price and a deal can't be keyed in at the till.
										...(application === 'manual' &&
										state.valueType === 'fixed_price'
											? { valueType: 'percent' as const }
											: {}),
										...(application === 'manual' && setRule
											? { quantityKind: 'none' as const }
											: {}),
									})
								}}
								choices={[
									{
										value: 'automatic',
										label: <Trans>Automatic</Trans>,
										description: features.automatic ? (
											<Trans>Applies by itself when an order qualifies.</Trans>
										) : (
											<Trans>Switched off for your organization.</Trans>
										),
										disabled: !features.automatic,
									},
									{
										value: 'code',
										label: <Trans>Coupon code</Trans>,
										description: features.coupons ? (
											<Trans>Applies when a customer enters a code.</Trans>
										) : (
											<Trans>Switched off for your organization.</Trans>
										),
										disabled: !features.coupons,
									},
									{
										value: 'manual',
										label: <Trans>At the till</Trans>,
										description: tierLock ? (
											<Trans>
												Not available with tiers. Turn tiers off first.
											</Trans>
										) : (
											<Trans>
												The cashier applies it on the register. A variable
												discount asks them for the amount or percent.
											</Trans>
										),
										disabled: tierLock,
									},
								]}
							/>
							<ChoiceGroup
								field="valueType"
								legend={<Trans>Discount</Trans>}
								value={state.valueType}
								error={errors.valueType ? errorText(errors.valueType) : null}
								columns={2}
								onChange={(valueType) =>
									patch({
										valueType,
										// A set price covers every matching item, so a counted rule can't stay.
										...(valueType === 'fixed_price' &&
										(state.quantityKind === 'exact' ||
											state.quantityKind === 'minimum' ||
											state.quantityKind === 'bogo')
											? { quantityKind: 'none' as const }
											: {}),
									})
								}
								choices={(state.application === 'manual'
									? ([
											'percent',
											'fixed',
											'variable_percent',
											'variable_amount',
											'free_delivery',
										] as const)
									: ([
											'percent',
											'fixed',
											'fixed_price',
											'free_delivery',
										] as const)
								).map((value) => ({
									value,
									label: i18n._(DISCOUNT_VALUE_TYPE_LABELS[value]),
									// A set price and free delivery can't carry a ladder.
									description:
										noAmounts && AMOUNT_VALUE_TYPES.has(value) ? (
											<Trans>
												Not available yet for <bdi>{currency}</bdi>. Use a
												percentage.
											</Trans>
										) : tierLock &&
										  (value === 'fixed_price' || value === 'free_delivery') ? (
											<Trans>
												Not available with tiers. Turn tiers off first.
											</Trans>
										) : (
											valueDescription(value)
										),
									// The saved value stays selectable so it can be seen and changed.
									disabled:
										(noAmounts &&
											AMOUNT_VALUE_TYPES.has(value) &&
											state.valueType !== value) ||
										(tierLock &&
											(value === 'fixed_price' || value === 'free_delivery')),
								}))}
							/>
							{state.valueType === 'variable_percent' ||
							state.valueType === 'variable_amount' ? (
								<p className="text-muted-foreground text-sm">
									{state.valueType === 'variable_percent' ? (
										<Trans>The cashier types the percent at the till.</Trans>
									) : (
										<Trans>The cashier types the amount at the till.</Trans>
									)}
								</p>
							) : null}
							{state.valueType === 'percent' ||
							state.valueType === 'variable_percent' ||
							state.valueType === 'variable_amount' ? (
								<div className="grid gap-4 sm:grid-cols-2">
									{state.valueType === 'percent' && !tiered ? (
										<TextField
											field="percent"
											label={<Trans>Percent off</Trans>}
											value={state.percent}
											error={errors.percent}
											inputMode="decimal"
											suffix="%"
											onChange={(percent) => patch({ percent })}
										/>
									) : null}
									<TextField
										field="maxDiscount"
										label={<Trans>Maximum off</Trans>}
										hint={
											<Trans>
												Optional cap for one order, in <bdi>{currency}</bdi>.
											</Trans>
										}
										value={state.maxDiscount}
										error={errors.maxDiscount}
										inputMode="decimal"
										onChange={(maxDiscount) => patch({ maxDiscount })}
									/>
								</div>
							) : null}
							{(state.valueType === 'fixed' && !tiered) ||
							state.valueType === 'fixed_price' ? (
								<TextField
									field="amount"
									label={
										state.valueType === 'fixed_price' ? (
											<Trans>Set price</Trans>
										) : amountPerItem ? (
											state.scope === 'modifiers' ? (
												<Trans>Amount off each choice</Trans>
											) : (
												<Trans>Amount off each item</Trans>
											)
										) : (
											<Trans>Amount off</Trans>
										)
									}
									hint={amountHint({
										valueType: state.valueType,
										quantityKind: state.quantityKind,
										scope: state.scope,
										amountPerItem,
										currency,
									})}
									value={state.amount}
									error={errors.amount}
									inputMode="decimal"
									onChange={(amount) => patch({ amount })}
								/>
							) : null}
							{freeDelivery ? (
								<TextField
									field="maxDeliveryFee"
									label={<Trans>Largest fee to waive</Trans>}
									hint={
										<Trans>
											Optional. Amount in <bdi>{currency}</bdi>. Free delivery
											only applies when the delivery fee is this much or less.
										</Trans>
									}
									value={state.maxDeliveryFee}
									error={errors.maxDeliveryFee}
									inputMode="decimal"
									onChange={(maxDeliveryFee) => patch({ maxDeliveryFee })}
								/>
							) : null}
							{percentOrAmount ? (
								<>
									<SwitchRow
										label={<Trans>Use tiers</Trans>}
										description={
											canTier ? (
												<Trans>
													The more the customer spends or buys, the bigger the
													discount.
												</Trans>
											) : (
												<Trans>
													Tiers go with a plain item or order discount. They are
													not available at the till, with a quantity rule, a
													meal deal or modifier choices.
												</Trans>
											)
										}
										checked={tiered}
										disabled={!canTier}
										onCheckedChange={(tiersOn) => patch({ tiersOn })}
									/>
									{tiered ? (
										<Indented>
											<TierSteps
												basis={state.tierBasis}
												rows={state.tiers}
												percent={state.valueType === 'percent'}
												currency={currency}
												errors={errors}
												onBasisChange={(tierBasis) => patch({ tierBasis })}
												onChange={(tiers) => patch({ tiers })}
											/>
										</Indented>
									) : null}
								</>
							) : null}
							{state.scope === 'modifiers' && !setRule && !freeDelivery ? (
								<p className="text-muted-foreground text-sm">
									<Trans>
										The discount applies to the price of each choice, not the
										item itself.
									</Trans>
								</p>
							) : null}
							{setRule && state.valueType !== 'fixed_price' ? (
								<p className="text-muted-foreground text-sm">
									{state.quantityKind === 'buy_get' ? (
										<Trans>
											The discount applies to each item the customer gets.
										</Trans>
									) : (
										<Trans>
											The discount applies to each full deal as a whole.
										</Trans>
									)}
								</p>
							) : null}
						</EditorSection>

						<EditorSection
							id="discount-section-target"
							title={<Trans>Applies to</Trans>}
							description={
								freeDelivery ? (
									<Trans>
										Free delivery takes the delivery fee off the order.
									</Trans>
								) : (
									<Trans>
										Choose the whole order, items, categories or modifier
										choices.
									</Trans>
								)
							}
						>
							{setRule ? (
								<p className="text-muted-foreground text-sm">
									<Trans>
										This deal chooses its own items under Quantity. The
										exclusions below still apply.
									</Trans>
								</p>
							) : (
								<>
									<ChoiceGroup
										field="scope"
										legend={<Trans>Applies to</Trans>}
										value={freeDelivery ? 'order' : state.scope}
										error={errors.target ? errorText(errors.target) : null}
										columns={2}
										onChange={(scope) =>
											patch({
												scope,
												// The counted rules fit item discounts and "first few per
												// item" fits modifier discounts, so a switch drops a rule
												// the new choice can't use.
												...(scope === 'modifiers' &&
												state.quantityKind !== 'per_item'
													? { quantityKind: 'none' as const }
													: {}),
												...(scope !== 'modifiers' &&
												state.quantityKind === 'per_item'
													? { quantityKind: 'none' as const }
													: {}),
											})
										}
										choices={[
											{
												value: 'order',
												label: <Trans>Whole order</Trans>,
												description: <Trans>Everything in the cart.</Trans>,
												disabled: freeDelivery,
											},
											{
												value: 'items',
												label: <Trans>Specific items</Trans>,
												description: <Trans>Only the items you pick.</Trans>,
												disabled: freeDelivery,
											},
											{
												value: 'categories',
												label: <Trans>Specific categories</Trans>,
												description: (
													<Trans>Every item in the categories you pick.</Trans>
												),
												disabled: freeDelivery,
											},
											{
												value: 'modifiers',
												label: <Trans>Modifier choices</Trans>,
												description: tierLock ? (
													<Trans>
														Not available with tiers. Turn tiers off first.
													</Trans>
												) : (
													<Trans>
														Toppings, sauces and other choices on an item.
													</Trans>
												),
												disabled: freeDelivery || tierLock,
											},
										]}
									/>
									{state.scope === 'items' && !freeDelivery ? (
										<CatalogPicker
											id={fieldDomId('target')}
											label={<Trans>Items</Trans>}
											options={catalog.items}
											value={state.itemIds}
											multiple
											placeholder={t`Search items`}
											emptyMessage={<Trans>No items yet.</Trans>}
											error={errors.target ? errorText(errors.target) : null}
											onChange={(itemIds) => patch({ itemIds })}
										/>
									) : null}
									{state.scope === 'categories' && !freeDelivery ? (
										<CatalogPicker
											id={fieldDomId('target')}
											label={<Trans>Categories</Trans>}
											options={catalog.categories}
											value={state.categoryIds}
											multiple
											placeholder={t`Search categories`}
											emptyMessage={<Trans>No categories yet.</Trans>}
											error={errors.target ? errorText(errors.target) : null}
											onChange={(categoryIds) => patch({ categoryIds })}
										/>
									) : null}
									{(state.scope === 'items' || state.scope === 'categories') &&
									!freeDelivery ? (
										<VariantFilter
											field="variants"
											rows={state.variants}
											groups={choices.variantGroups}
											error={pickError('variants')}
											onChange={(variants) => patch({ variants })}
										/>
									) : null}
									{state.scope === 'modifiers' && !freeDelivery ? (
										<>
											<CatalogPicker
												id={fieldDomId('target')}
												label={<Trans>Modifier groups</Trans>}
												hint={
													<Trans>
														Every choice in these groups is covered.
													</Trans>
												}
												options={choices.groups}
												value={state.modifierGroupIds}
												multiple
												placeholder={t`Search modifier groups`}
												emptyMessage={<Trans>No modifier groups yet.</Trans>}
												error={errors.target ? errorText(errors.target) : null}
												onChange={(modifierGroupIds) =>
													patch({ modifierGroupIds })
												}
											/>
											<CatalogPicker
												id={fieldDomId('modifier-options')}
												error={pickError('modifier-options')}
												label={<Trans>Modifier options</Trans>}
												hint={
													<Trans>
														Optional. Single choices, whichever group they sit
														in.
													</Trans>
												}
												options={choices.options}
												value={state.modifierOptionIds}
												multiple
												placeholder={t`Search modifier options`}
												emptyMessage={<Trans>No modifier options yet.</Trans>}
												onChange={(modifierOptionIds) =>
													patch({ modifierOptionIds })
												}
											/>
											<CatalogPicker
												id={fieldDomId('modifier-items')}
												error={pickError('modifier-items')}
												label={<Trans>Only on these items</Trans>}
												hint={
													<Trans>
														Optional. Leave empty to cover every item.
													</Trans>
												}
												options={catalog.items}
												value={state.itemIds}
												multiple
												placeholder={t`Search items`}
												emptyMessage={<Trans>No items yet.</Trans>}
												onChange={(itemIds) => patch({ itemIds })}
											/>
											<CatalogPicker
												id={fieldDomId('modifier-categories')}
												error={pickError('modifier-categories')}
												label={<Trans>Only in these categories</Trans>}
												options={catalog.categories}
												value={state.categoryIds}
												multiple
												placeholder={t`Search categories`}
												emptyMessage={<Trans>No categories yet.</Trans>}
												onChange={(categoryIds) => patch({ categoryIds })}
											/>
											<VariantFilter
												field="modifier-variants"
												rows={state.variants}
												groups={choices.variantGroups}
												error={pickError('modifier-variants')}
												onChange={(variants) => patch({ variants })}
											/>
										</>
									) : null}
								</>
							)}
							{!freeDelivery ? (
								<>
									<CatalogPicker
										id={fieldDomId('exclude-items')}
										error={pickError('exclude-items')}
										label={<Trans>Exclude items</Trans>}
										hint={
											<Trans>
												Optional. These items never receive this discount.
											</Trans>
										}
										options={catalog.items}
										value={state.excludeItemIds}
										multiple
										placeholder={t`Search items to exclude`}
										emptyMessage={<Trans>No items yet.</Trans>}
										onChange={(excludeItemIds) => patch({ excludeItemIds })}
									/>
									<CatalogPicker
										id={fieldDomId('exclude-categories')}
										error={pickError('exclude-categories')}
										label={<Trans>Exclude categories</Trans>}
										options={catalog.categories}
										value={state.excludeCategoryIds}
										multiple
										placeholder={t`Search categories to exclude`}
										emptyMessage={<Trans>No categories yet.</Trans>}
										onChange={(excludeCategoryIds) =>
											patch({ excludeCategoryIds })
										}
									/>
									<SwitchRow
										label={<Trans>Require specific items or categories</Trans>}
										description={
											<Trans>
												The order must already include them before the discount
												applies.
											</Trans>
										}
										checked={state.requireOn}
										onCheckedChange={(requireOn) => patch({ requireOn })}
									/>
									{state.requireOn ? (
										<Indented>
											<TextField
												field="requireQuantity"
												label={<Trans>Quantity required</Trans>}
												value={state.requireQuantity}
												error={errors.requireQuantity}
												inputMode="numeric"
												onChange={(requireQuantity) =>
													patch({ requireQuantity })
												}
											/>
											<CatalogPicker
												id={fieldDomId('requirement')}
												label={<Trans>Required items</Trans>}
												options={catalog.items}
												value={state.requireItemIds}
												multiple
												placeholder={t`Search items`}
												emptyMessage={<Trans>No items yet.</Trans>}
												error={
													errors.requirement
														? errorText(errors.requirement)
														: null
												}
												onChange={(requireItemIds) => patch({ requireItemIds })}
											/>
											<CatalogPicker
												id={fieldDomId('require-categories')}
												error={pickError('require-categories')}
												label={<Trans>Required categories</Trans>}
												options={catalog.categories}
												value={state.requireCategoryIds}
												multiple
												placeholder={t`Search categories`}
												emptyMessage={<Trans>No categories yet.</Trans>}
												onChange={(requireCategoryIds) =>
													patch({ requireCategoryIds })
												}
											/>
										</Indented>
									) : null}
								</>
							) : null}
						</EditorSection>

						{!freeDelivery ? (
							<EditorSection
								id="discount-section-quantity"
								title={<Trans>Quantity</Trans>}
								description={
									<Trans>
										How many of the matching items receive the discount.
									</Trans>
								}
							>
								<ChoiceGroup
									field="quantityKind"
									legend={<Trans>Quantity rule</Trans>}
									value={state.quantityKind}
									error={
										errors.quantityRule ? errorText(errors.quantityRule) : null
									}
									columns={2}
									onChange={(quantityKind) => patch({ quantityKind })}
									choices={quantityChoices({ ...state, tierLock })}
								/>
								{state.quantityKind === 'minimum' ||
								state.quantityKind === 'exact' ? (
									<TextField
										field="quantityN"
										label={<Trans>Quantity</Trans>}
										value={state.quantityN}
										error={errors.quantityN}
										inputMode="numeric"
										onChange={(quantityN) => patch({ quantityN })}
									/>
								) : null}
								{state.quantityKind === 'per_item' ? (
									<TextField
										field="perItemN"
										label={<Trans>Choices per item</Trans>}
										value={state.perItemN}
										error={errors.perItemN}
										inputMode="numeric"
										className="sm:max-w-32"
										onChange={(perItemN) => patch({ perItemN })}
									/>
								) : null}
								{state.quantityKind === 'bogo' ? (
									<div className="grid gap-4 sm:grid-cols-2">
										<TextField
											field="buyQuantity"
											label={<Trans>Buy</Trans>}
											value={state.buyQuantity}
											error={errors.buyQuantity}
											inputMode="numeric"
											onChange={(buyQuantity) => patch({ buyQuantity })}
										/>
										<TextField
											field="getQuantity"
											label={<Trans>Discount</Trans>}
											value={state.getQuantity}
											error={errors.getQuantity}
											inputMode="numeric"
											onChange={(getQuantity) => patch({ getQuantity })}
										/>
									</div>
								) : null}
								{state.quantityKind === 'buy_get' ? (
									<BuyGetGroups
										buy={state.buyGroup}
										get={state.getGroup}
										catalog={catalog}
										variantGroups={choices.variantGroups}
										currency={currency}
										errors={errors}
										onBuyChange={(buyGroup) => patch({ buyGroup })}
										onGetChange={(getGroup) => patch({ getGroup })}
									/>
								) : null}
								{state.quantityKind === 'bundle' ? (
									<DealSlots
										slots={state.bundleSlots}
										catalog={catalog}
										variantGroups={choices.variantGroups}
										currency={currency}
										errors={errors}
										onChange={(bundleSlots) => patch({ bundleSlots })}
									/>
								) : null}
								<TextField
									field="maxUnits"
									label={<Trans>Items discounted per use</Trans>}
									hint={
										state.quantityKind === 'buy_get' ? (
											<Trans>
												Optional. The most items discounted in one order.
											</Trans>
										) : state.quantityKind === 'bundle' ? (
											<Trans>
												Optional. The most items deals cover in one order, such
												as 4 for two deals of 2.
											</Trans>
										) : state.scope === 'modifiers' ? (
											<Trans>
												Optional. The most choices discounted in one order, most
												expensive first.
											</Trans>
										) : itemScope ? (
											<Trans>
												Optional. The most expensive matching items are
												discounted first.
											</Trans>
										) : (
											<Trans>Only for a discount on items or categories.</Trans>
										)
									}
									value={state.maxUnits}
									error={errors.maxUnits}
									inputMode="numeric"
									disabled={!itemScope}
									onChange={(maxUnits) => patch({ maxUnits })}
								/>
							</EditorSection>
						) : null}

						<EditorSection
							id="discount-section-when"
							title={<Trans>When</Trans>}
							description={
								<Trans>
									Dates and weekly hours use each location's own time zone.
								</Trans>
							}
						>
							<div className="grid gap-4 sm:grid-cols-2">
								<TextField
									field="startsAt"
									label={<Trans>Starts</Trans>}
									hint={<Trans>Optional.</Trans>}
									type="datetime-local"
									value={state.startsAt}
									error={errors.startsAt}
									onChange={(startsAt) => patch({ startsAt })}
								/>
								<TextField
									field="endsAt"
									label={<Trans>Ends</Trans>}
									hint={
										<Trans>
											Optional. The discount stops at this time. Leave blank to
											keep it open.
										</Trans>
									}
									type="datetime-local"
									value={state.endsAt}
									error={errors.endsAt}
									onChange={(endsAt) => patch({ endsAt })}
								/>
							</div>
							<SwitchRow
								label={<Trans>Limit to weekly hours</Trans>}
								description={
									<Trans>
										A window that ends earlier than it starts runs past
										midnight.
									</Trans>
								}
								checked={state.hoursOn}
								onCheckedChange={(hoursOn) => patch({ hoursOn })}
							/>
							{state.hoursOn ? (
								<WeeklyHours
									rows={state.schedule}
									errors={errors}
									locale={i18n.locale}
									onChange={(schedule) => patch({ schedule })}
								/>
							) : null}
						</EditorSection>

						<EditorSection
							id="discount-section-where"
							title={<Trans>Where</Trans>}
						>
							<SwitchRow
								label={<Trans>All locations</Trans>}
								checked={state.allLocations}
								onCheckedChange={(allLocations) => patch({ allLocations })}
							/>
							{!state.allLocations ? (
								<CheckboxGroup
									field="locations"
									legend={<Trans>Locations</Trans>}
									value={state.locationIds}
									error={errors.locations ? errorText(errors.locations) : null}
									onChange={(locationIds) => patch({ locationIds })}
									options={locations.map((location) => ({
										value: location.id,
										label: location.name,
									}))}
								/>
							) : null}
							{mixedCurrencyNotice ? (
								<p
									// "All locations" has no locations field to jump to.
									id={state.allLocations ? fieldDomId('locations') : undefined}
									tabIndex={-1}
									role={errors.locations ? 'alert' : 'status'}
									className={cn(
										'text-sm',
										errors.locations
											? 'text-destructive'
											: 'text-muted-foreground',
									)}
								>
									<Trans>
										Your locations use different currencies. Choose locations
										that share one currency to set an amount.
									</Trans>
								</p>
							) : null}
							<CheckboxGroup
								field="channels"
								legend={<Trans>Channels</Trans>}
								value={state.channels}
								error={errors.channels ? errorText(errors.channels) : null}
								onChange={(channels) => patch({ channels })}
								options={ALL_CHANNELS.map((value) => ({
									value,
									label: i18n._(DISCOUNT_CHANNEL_LABELS[value]),
								}))}
							/>
							<CheckboxGroup
								field="fulfillments"
								legend={<Trans>Order types</Trans>}
								value={state.fulfillments}
								error={
									errors.fulfillments ? errorText(errors.fulfillments) : null
								}
								onChange={(fulfillments) => patch({ fulfillments })}
								options={ALL_FULFILLMENTS.map((value) => ({
									value,
									label: i18n._(DISCOUNT_FULFILLMENT_LABELS[value]),
								}))}
							/>
							<SwitchRow
								label={<Trans>Include drop orders</Trans>}
								description={
									<Trans>Drop orders skip discounts unless this is on.</Trans>
								}
								checked={state.includeDrops}
								onCheckedChange={(includeDrops) => patch({ includeDrops })}
							/>
						</EditorSection>

						<EditorSection
							id="discount-section-who"
							title={<Trans>Who can use it</Trans>}
						>
							<ChoiceGroup
								field="eligibility"
								legend={<Trans>Customers</Trans>}
								value={state.eligibility}
								onChange={(eligibility) => patch({ eligibility })}
								choices={(
									[
										'everyone',
										'signed_in',
										'new_customer',
										'loyalty_member',
									] as const
								).map((value) => ({
									value,
									label: i18n._(DISCOUNT_ELIGIBILITY_LABELS[value]),
								}))}
							/>
							<Field>
								<FieldLabel htmlFor={fieldDomId('totalLimit')}>
									<Trans>Maximum uses</Trans>
								</FieldLabel>
								<select
									id={fieldDomId('totalLimit')}
									className="border-input bg-card h-8 w-full rounded-md border px-2.5 text-sm"
									value={state.totalLimit}
									aria-invalid={errors.totalLimit ? true : undefined}
									aria-describedby={
										errors.totalLimit
											? `${fieldDomId('totalLimit')}-error`
											: undefined
									}
									onChange={(event) =>
										patch({
											totalLimit: event.currentTarget
												.value as EditorState['totalLimit'],
										})
									}
								>
									<option value="unlimited">{t`Unlimited`}</option>
									{DISCOUNT_TOTAL_LIMIT_PRESETS.map((preset) => (
										<option key={preset} value={String(preset)}>
											{preset}
										</option>
									))}
									<option value="custom">{t`Custom`}</option>
								</select>
								{errors.totalLimit ? (
									<FieldErrorText id={`${fieldDomId('totalLimit')}-error`}>
										{errorText(errors.totalLimit)}
									</FieldErrorText>
								) : null}
							</Field>
							{state.totalLimit === 'custom' ? (
								<TextField
									field="totalLimitCustom"
									label={<Trans>Custom maximum</Trans>}
									value={state.totalLimitCustom}
									error={errors.totalLimitCustom ?? errors.totalLimit}
									inputMode="numeric"
									onChange={(totalLimitCustom) => patch({ totalLimitCustom })}
								/>
							) : null}
							<TextField
								field="minSubtotal"
								label={<Trans>Minimum spend</Trans>}
								hint={
									<Trans>
										Optional. Checked on the subtotal before discounts.
									</Trans>
								}
								value={state.minSubtotal}
								error={errors.minSubtotal}
								inputMode="decimal"
								onChange={(minSubtotal) => patch({ minSubtotal })}
							/>
							<SwitchRow
								label={<Trans>Limit uses per customer</Trans>}
								description={
									<Trans>
										Guests can't use this discount: customers have to be signed
										in so their uses can be counted.
									</Trans>
								}
								checked={state.perCustomerOn}
								onCheckedChange={(perCustomerOn) => patch({ perCustomerOn })}
							/>
							{state.perCustomerOn ? (
								<Indented>
									<TextField
										field="perCustomerCount"
										label={<Trans>Uses allowed</Trans>}
										value={state.perCustomerCount}
										error={errors.perCustomerCount}
										inputMode="numeric"
										onChange={(perCustomerCount) => patch({ perCustomerCount })}
									/>
									<ChoiceGroup
										field="perCustomerPeriod"
										legend={<Trans>How the limit is counted</Trans>}
										value={state.perCustomerPeriod}
										onChange={(perCustomerPeriod) =>
											patch({ perCustomerPeriod })
										}
										choices={(['lifetime', 'day', 'week'] as const).map(
											(value) => ({
												value,
												label: i18n._(DISCOUNT_PERIOD_LABELS[value]),
											}),
										)}
									/>
								</Indented>
							) : null}
						</EditorSection>

						{state.application === 'code' ? (
							<EditorSection
								id="discount-section-codes"
								title={<Trans>Codes</Trans>}
								description={
									<Trans>
										Customers type one of these at checkout. Letters and
										numbers, 3 to 24 characters.
									</Trans>
								}
							>
								<CodesEditor
									codes={state.codes}
									errors={errors}
									onChange={(codes) => patch({ codes })}
								/>
							</EditorSection>
						) : null}

						<EditorSection
							id="discount-section-options"
							title={<Trans>Options</Trans>}
						>
							<CheckboxGroup
								field="combinesWith"
								legend={<Trans>Can combine with</Trans>}
								hint={
									<Trans>
										Two discounts combine only if each allows the other's kind.
										With none ticked, this discount stands alone: the customer
										gets it or the others, whichever saves more.
									</Trans>
								}
								error={
									errors.combinesWith ? errorText(errors.combinesWith) : null
								}
								value={state.combinesWith}
								onChange={(combinesWith) => patch({ combinesWith })}
								options={DISCOUNT_COMBINE_CLASS_VALUES.map((value) => ({
									value,
									label: i18n._(DISCOUNT_COMBINE_LABELS[value]),
								}))}
							/>
							<TextField
								field="priority"
								label={<Trans>Priority</Trans>}
								hint={
									<Trans>
										Lower numbers are considered first. 0 is the default.
									</Trans>
								}
								value={state.priority}
								error={errors.priority}
								inputMode="numeric"
								onChange={(priority) => patch({ priority })}
							/>
							<SwitchRow
								label={<Trans>Promote on your menu</Trans>}
								description={
									promoteOnMenuAllowed(state) ? (
										<Trans>Shows it as an offer on your online menu.</Trans>
									) : (
										<Trans>
											Only for discounts everyone can use: the menu can't say
											who qualifies. Set Customers to Everyone to promote it.
										</Trans>
									)
								}
								checked={state.promoteOnMenu && promoteOnMenuAllowed(state)}
								disabled={!promoteOnMenuAllowed(state)}
								onCheckedChange={(promoteOnMenu) => patch({ promoteOnMenu })}
							/>
							<SwitchRow
								label={<Trans>Require a manager at the till</Trans>}
								description={
									<Trans>
										Stored for the in-store till. It has no effect online.
									</Trans>
								}
								checked={state.requireApproval}
								onCheckedChange={(requireApproval) =>
									patch({ requireApproval })
								}
							/>
						</EditorSection>
					</fieldset>

					<aside className="lg:col-span-4">
						<div className="lg:sticky lg:top-20">
							<DiscountSummary
								state={state}
								currency={amountsCurrency}
								catalog={catalog}
								choices={choices}
								locations={locations}
								defaultLocale={siteLocales.defaultLocale}
							/>
						</div>
					</aside>
				</div>
			</Form>
		</EditorCurrencyContext.Provider>
	)
}
