import { getFormProps, useForm, useInputControl } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod/v4'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	LOYALTY_MAX_CATEGORY_IDS,
	LOYALTY_MAX_ITEM_IDS,
	LOYALTY_PROMOTION_MAX_FLAT_POINTS,
	loyaltyPromotionSchema,
	type LoyaltyCatalogLabels,
	type LoyaltyProgramConfig,
	type LoyaltyPromotion,
	type LoyaltyPromotionKind,
} from '@repo/loyalty'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Switch } from '@repo/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useMemo, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { ErrorList } from '#app/components/forms.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	catalogLabelsFor,
	joinCatalogIds,
	splitCatalogIds,
	type LoyaltyCatalog,
} from '#app/utils/loyalty/catalog.ts'
import { isUsableTimeZone } from '#app/utils/loyalty/loyalty-view.ts'
import {
	describePromotionExample,
	instantToLocalInput,
	minutesToTimeInput,
	multiplierToInput,
	newPromotionId,
	parseLocalInput,
	parseMultiplierToBp,
	parseTimeInput,
	promotionExample,
} from '#app/utils/loyalty/promotions.ts'
import { parseWholeNumber } from '#app/utils/money-input.ts'
import { CatalogPicker } from './catalog-picker.tsx'

export type PromotionLocation = { id: string; name: string }

/** What the form holds: every field as the text or choice the operator gave. */
export type PromotionFormValues = {
	name: string
	kind: LoyaltyPromotionKind
	multiplier: string
	bonusPoints: string
	scope: 'order' | 'items' | 'categories'
	itemIds: string
	categoryIds: string
	startsAt: string
	endsAt: string
	weekly: 'yes' | 'no'
	weekdays: string
	fromTime: string
	toTime: string
	locationMode: 'all' | 'selected'
	locationIds: string
	maxPoints: string
	enabled: 'yes' | 'no'
}

const DEFAULT_FROM = '09:00'
const DEFAULT_TO = '17:00'

export function promotionDefaults(
	promotion: LoyaltyPromotion | null,
	timeZone: string,
): PromotionFormValues {
	const recurring = promotion?.recurring ?? null
	return {
		name: promotion?.name ?? '',
		kind: promotion?.kind ?? 'multiplier',
		multiplier:
			promotion?.kind === 'multiplier'
				? multiplierToInput(promotion.value)
				: '2',
		bonusPoints: promotion?.kind === 'bonus' ? String(promotion.value) : '',
		scope: promotion?.scope.type ?? 'order',
		itemIds:
			promotion?.scope.type === 'items'
				? joinCatalogIds(promotion.scope.itemIds)
				: '',
		categoryIds:
			promotion?.scope.type === 'categories'
				? joinCatalogIds(promotion.scope.categoryIds)
				: '',
		startsAt: instantToLocalInput(promotion?.startsAt, timeZone),
		endsAt: instantToLocalInput(promotion?.endsAt, timeZone),
		weekly: recurring ? 'yes' : 'no',
		weekdays: recurring ? recurring.weekdays.join(',') : '',
		fromTime: recurring
			? minutesToTimeInput(recurring.fromMinute)
			: DEFAULT_FROM,
		toTime: recurring ? minutesToTimeInput(recurring.toMinute) : DEFAULT_TO,
		locationMode: promotion?.locationIds ? 'selected' : 'all',
		locationIds: promotion?.locationIds ? promotion.locationIds.join(',') : '',
		maxPoints:
			promotion?.maxPointsPerPurchase !== null &&
			promotion?.maxPointsPerPurchase !== undefined
				? String(promotion.maxPointsPerPurchase)
				: '',
		enabled: promotion?.enabled === false ? 'no' : 'yes',
	}
}

/** "00:00" as an end time means the end of the day. */
function endMinutes(input: string): number | null {
	const minutes = parseTimeInput(input)
	return minutes === 0 ? 1440 : minutes
}

function idList(csv: string): string[] {
	return csv === '' ? [] : csv.split(',').filter(Boolean)
}

/**
 * The promotion the form describes, ready for `loyaltyPromotionSchema`. Assumes
 * the values passed validation. Names are captured from the menu so customers
 * keep seeing them after the menu changes.
 */
export function promotionFromValues(
	value: PromotionFormValues,
	input: {
		id: string
		timeZone: string
		catalog: LoyaltyCatalog
		saved: LoyaltyPromotion | null
	},
): unknown {
	const savedLabels: LoyaltyCatalogLabels = input.saved?.labels ?? {
		items: {},
		categories: {},
	}
	const itemIds = splitCatalogIds(value.itemIds)
	const categoryIds = splitCatalogIds(value.categoryIds)
	const scope =
		value.scope === 'items'
			? { type: 'items', itemIds }
			: value.scope === 'categories'
				? { type: 'categories', categoryIds }
				: { type: 'order' }
	const locationIds = idList(value.locationIds)
	return {
		id: input.id,
		name: value.name,
		enabled: value.enabled === 'yes',
		kind: value.kind,
		value:
			value.kind === 'multiplier'
				? parseMultiplierToBp(value.multiplier)
				: parseWholeNumber(value.bonusPoints),
		scope,
		startsAt: parseLocalInput(value.startsAt, input.timeZone) ?? null,
		endsAt: parseLocalInput(value.endsAt, input.timeZone) ?? null,
		recurring:
			value.weekly === 'yes'
				? {
						weekdays: idList(value.weekdays)
							.map(Number)
							.sort((a, b) => a - b),
						fromMinute: parseTimeInput(value.fromTime),
						toMinute: endMinutes(value.toTime),
					}
				: null,
		locationIds:
			value.locationMode === 'selected' && locationIds.length > 0
				? locationIds
				: null,
		maxPointsPerPurchase:
			value.maxPoints.trim() === '' ? null : parseWholeNumber(value.maxPoints),
		labels: {
			items:
				value.scope === 'items'
					? catalogLabelsFor(itemIds, input.catalog.items, savedLabels.items)
					: {},
			categories:
				value.scope === 'categories'
					? catalogLabelsFor(
							categoryIds,
							input.catalog.categories,
							savedLabels.categories,
						)
					: {},
		},
	}
}

const WEEKDAY_VALUES = ['0', '1', '2', '3', '4', '5', '6'] as const

/**
 * Creates a promotion, or changes one. The dialog builds the promotion and
 * hands it to `onSubmit`, which saves the program with it and answers with an
 * error message, or null when it saved.
 */
export function PromotionDialog({
	promotion,
	config,
	catalog,
	locations,
	now = Date.now(),
	onClose,
	onSubmit,
}: {
	promotion: LoyaltyPromotion | null
	/** The program being edited: its time zone, currency and earning rule. */
	config: LoyaltyProgramConfig
	catalog: LoyaltyCatalog
	locations: readonly PromotionLocation[]
	/** The clock the example runs on; tests pin it. */
	now?: number
	onClose: () => void
	onSubmit: (promotion: LoyaltyPromotion) => Promise<string | null>
}) {
	const [submitting, setSubmitting] = useState(false)
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				// Closing mid-request would read as a cancel, but the save lands.
				if (!open && !submitting) onClose()
			}}
		>
			<DialogContent
				className="sm:max-w-xl"
				data-testid="loyalty-promotion-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						{promotion ? (
							<Trans>Edit promotion</Trans>
						) : (
							<Trans>New promotion</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Bonus points on top of what customers already earn, for the days,
							hours, items and places you choose.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<PromotionForm
					promotion={promotion}
					config={config}
					catalog={catalog}
					locations={locations}
					now={now}
					submitting={submitting}
					onSubmittingChange={setSubmitting}
					onClose={onClose}
					onSubmit={onSubmit}
				/>
			</DialogContent>
		</Dialog>
	)
}

function PromotionForm({
	promotion,
	config,
	catalog,
	locations,
	now,
	submitting,
	onSubmittingChange: setSubmitting,
	onClose,
	onSubmit,
}: {
	promotion: LoyaltyPromotion | null
	config: LoyaltyProgramConfig
	catalog: LoyaltyCatalog
	locations: readonly PromotionLocation[]
	now: number
	submitting: boolean
	onSubmittingChange: (submitting: boolean) => void
	onClose: () => void
	onSubmit: (promotion: LoyaltyPromotion) => Promise<string | null>
}) {
	const { t, i18n } = useLingui()
	const timeZone = isUsableTimeZone(config.timeZone) ? config.timeZone : 'UTC'
	const defaults = useMemo(
		() => promotionDefaults(promotion, timeZone),
		[promotion, timeZone],
	)
	const [id] = useState(() => promotion?.id ?? newPromotionId())
	const [kind, setKind] = useState<LoyaltyPromotionKind>(defaults.kind)
	const [scope, setScope] = useState(defaults.scope)
	const [weekly, setWeekly] = useState(defaults.weekly === 'yes')
	const [weekdays, setWeekdays] = useState<string[]>(idList(defaults.weekdays))
	const [locationMode, setLocationMode] = useState(defaults.locationMode)
	const [locationIds, setLocationIds] = useState<string[]>(
		idList(defaults.locationIds),
	)
	const [enabled, setEnabled] = useState(defaults.enabled === 'yes')
	const [error, setError] = useState<string | null>(null)
	// The typed fields, as of the last keystroke: the live example reads them.
	const [typed, setTyped] = useState({
		name: defaults.name,
		multiplier: defaults.multiplier,
		bonusPoints: defaults.bonusPoints,
		startsAt: defaults.startsAt,
		endsAt: defaults.endsAt,
		fromTime: defaults.fromTime,
		toTime: defaults.toTime,
		maxPoints: defaults.maxPoints,
	})

	// Conform turns an empty or missing field into undefined, so every text
	// field defaults to '' and keeps its own message instead of "Required".
	const schema = useMemo(
		() =>
			z
				.object({
					name: z
						.string()
						.trim()
						.min(1, t`Enter a name for the promotion.`)
						.max(80, t`Keep the name under 80 characters.`)
						.prefault(''),
					kind: z.enum(['multiplier', 'bonus']),
					multiplier: z.string().trim().prefault(''),
					bonusPoints: z.string().trim().prefault(''),
					scope: z.enum(['order', 'items', 'categories']),
					itemIds: z.string().prefault(''),
					categoryIds: z.string().prefault(''),
					startsAt: z.string().trim().prefault(''),
					endsAt: z.string().trim().prefault(''),
					weekly: z.enum(['yes', 'no']).prefault('no'),
					weekdays: z.string().prefault(''),
					fromTime: z.string().trim().prefault(''),
					toTime: z.string().trim().prefault(''),
					locationMode: z.enum(['all', 'selected']).prefault('all'),
					locationIds: z.string().prefault(''),
					maxPoints: z.string().trim().prefault(''),
					enabled: z.enum(['yes', 'no']).prefault('yes'),
				})
				.superRefine((value, ctx) => {
					const issue = (path: string, message: string) =>
						ctx.addIssue({ code: 'custom', path: [path], message })
					if (value.kind === 'multiplier') {
						if (parseMultiplierToBp(value.multiplier) === null) {
							issue(
								'multiplier',
								t`Enter how many times the points, above 1 and up to 10. For example 2 or 1.5.`,
							)
						}
					} else if (
						parseWholeNumber(value.bonusPoints, {
							min: 1,
							max: LOYALTY_PROMOTION_MAX_FLAT_POINTS,
						}) === null
					) {
						issue(
							'bonusPoints',
							t`Enter a whole number of bonus points, at least 1.`,
						)
					}
					if (
						value.scope === 'items' &&
						splitCatalogIds(value.itemIds).length === 0
					) {
						issue('itemIds', t`Choose at least one item.`)
					}
					if (
						value.scope === 'categories' &&
						splitCatalogIds(value.categoryIds).length === 0
					) {
						issue('categoryIds', t`Choose at least one category.`)
					}
					const starts = parseLocalInput(value.startsAt, timeZone)
					const ends = parseLocalInput(value.endsAt, timeZone)
					if (starts === undefined) {
						issue('startsAt', t`Enter a real date and time.`)
					}
					if (ends === undefined) {
						issue('endsAt', t`Enter a real date and time.`)
					}
					if (
						typeof starts === 'number' &&
						typeof ends === 'number' &&
						ends <= starts
					) {
						issue('endsAt', t`The promotion must end after it starts.`)
					}
					if (value.weekly === 'yes') {
						if (idList(value.weekdays).length === 0) {
							issue('weekdays', t`Choose at least one day.`)
						}
						const from = parseTimeInput(value.fromTime)
						const to = endMinutes(value.toTime)
						if (from === null) issue('fromTime', t`Enter a time, like 15:00.`)
						if (to === null) issue('toTime', t`Enter a time, like 17:00.`)
						if (from !== null && to !== null && to <= from) {
							issue('toTime', t`The window must end after it starts.`)
						}
					}
					if (
						value.locationMode === 'selected' &&
						idList(value.locationIds).length === 0
					) {
						issue('locationIds', t`Choose at least one location.`)
					}
					if (
						value.maxPoints !== '' &&
						parseWholeNumber(value.maxPoints, { min: 1 }) === null
					) {
						issue(
							'maxPoints',
							t`Enter a whole number of points, or leave it empty.`,
						)
					}
				}),
		[t, timeZone],
	)

	const [form, fields] = useForm({
		id: 'loyalty-promotion-form',
		defaultValue: defaults,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema })
		},
		shouldValidate: 'onBlur',
		shouldRevalidate: 'onInput',
		onSubmit(event, { submission }) {
			event.preventDefault()
			if (submission?.status !== 'success') return
			const checked = loyaltyPromotionSchema.safeParse(
				promotionFromValues(submission.value as PromotionFormValues, {
					id,
					timeZone,
					catalog,
					saved: promotion,
				}),
			)
			if (!checked.success) {
				setError(t`Check the fields and try again.`)
				return
			}
			setSubmitting(true)
			setError(null)
			onSubmit(checked.data)
				.then((message) => {
					if (message) setError(message)
				})
				.catch(() => {
					setError(t`The promotion could not be saved.`)
				})
				.finally(() => {
					setSubmitting(false)
				})
		},
	})

	const itemsControl = useInputControl(fields.itemIds)
	const categoriesControl = useInputControl(fields.categoryIds)

	// The live example: the same parse the save goes through, over what is in
	// the form right now. Incomplete or invalid input shows a hint instead.
	const exampleValues: PromotionFormValues = {
		...typed,
		kind,
		scope,
		itemIds: itemsControl.value ?? '',
		categoryIds: categoriesControl.value ?? '',
		weekly: weekly ? 'yes' : 'no',
		weekdays: weekdays.join(','),
		locationMode,
		locationIds: locationIds.join(','),
		enabled: enabled ? 'yes' : 'no',
	}
	const exampleText = useMemo(() => {
		const parsed = schema.safeParse(exampleValues)
		if (!parsed.success) return null
		const built = loyaltyPromotionSchema.safeParse(
			promotionFromValues(parsed.data as PromotionFormValues, {
				id,
				timeZone,
				catalog,
				saved: promotion,
			}),
		)
		if (!built.success) return null
		return describePromotionExample(
			promotionExample({ config, promotion: built.data, now }),
			{ currency: config.currency, locale: i18n.locale, timeZone },
			(descriptor) => i18n._(descriptor),
		)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- exampleValues is rebuilt every render from the state listed here
	}, [
		schema,
		typed,
		kind,
		scope,
		weekly,
		weekdays,
		locationMode,
		locationIds,
		enabled,
		itemsControl.value,
		categoriesControl.value,
		config,
		catalog,
		promotion,
		id,
		timeZone,
		now,
		i18n,
	])

	function trackTyped(event: FormEvent<HTMLFormElement>) {
		const data = new FormData(event.currentTarget)
		const read = (name: keyof typeof typed) => String(data.get(name) ?? '')
		setTyped({
			name: read('name'),
			multiplier: read('multiplier'),
			bonusPoints: read('bonusPoints'),
			startsAt: read('startsAt'),
			endsAt: read('endsAt'),
			fromTime: read('fromTime'),
			toTime: read('toTime'),
			maxPoints: read('maxPoints'),
		})
	}

	const showLocations = locations.length > 1 || locationIds.length > 0
	const kindOptions = [
		{ value: 'multiplier', label: t`Multiply points` },
		{ value: 'bonus', label: t`Add bonus points` },
	]
	const scopeOptions = [
		{ value: 'order', label: t`The whole order` },
		{ value: 'items', label: t`Selected items` },
		{ value: 'categories', label: t`Selected categories` },
	]
	const weekdayNames: Record<string, string> = {
		'0': t`Sun`,
		'1': t`Mon`,
		'2': t`Tue`,
		'3': t`Wed`,
		'4': t`Thu`,
		'5': t`Fri`,
		'6': t`Sat`,
	}

	return (
		<form
			{...getFormProps(form)}
			onInput={trackTyped}
			className="flex flex-col gap-4"
			data-testid="loyalty-promotion-form"
		>
			<input type="hidden" name={fields.kind.name} value={kind} />
			<input type="hidden" name={fields.scope.name} value={scope} />
			<input
				type="hidden"
				name={fields.weekly.name}
				value={weekly ? 'yes' : 'no'}
			/>
			<input
				type="hidden"
				name={fields.weekdays.name}
				value={weekdays.join(',')}
			/>
			<input
				type="hidden"
				name={fields.locationMode.name}
				value={locationMode}
			/>
			<input
				type="hidden"
				name={fields.locationIds.name}
				value={locationIds.join(',')}
			/>
			<input
				type="hidden"
				name={fields.enabled.name}
				value={enabled ? 'yes' : 'no'}
			/>

			{error ? (
				<Alert variant="destructive" data-testid="loyalty-promotion-error">
					<Icon name="alert-triangle" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			<div className="flex max-h-96 flex-col gap-4 overflow-y-auto pe-1">
				<TextField
					label={<Trans>Name</Trans>}
					hint={t`Customers see this name in their wallet.`}
					id="loyalty-promotion-name"
					name={fields.name.name}
					defaultValue={defaults.name}
					error={fields.name.errors?.[0] ?? null}
					maxLength={80}
					data-testid="loyalty-promotion-name"
				/>

				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<SelectField
						label={<Trans>What it does</Trans>}
						id="loyalty-promotion-kind"
						testId="loyalty-promotion-kind"
						options={kindOptions}
						value={kind}
						onValueChange={(next) => setKind(next as LoyaltyPromotionKind)}
						error={fields.kind.errors?.[0] ?? null}
					/>
					{kind === 'multiplier' ? (
						<TextField
							key="multiplier"
							label={<Trans>Times the points</Trans>}
							hint={t`For example 2 for double points, or 1.5.`}
							id="loyalty-promotion-multiplier"
							name={fields.multiplier.name}
							defaultValue={defaults.multiplier}
							error={fields.multiplier.errors?.[0] ?? null}
							inputMode="decimal"
							placeholder="2"
							data-testid="loyalty-promotion-multiplier"
						/>
					) : (
						<TextField
							key="bonus"
							label={
								scope === 'order' ? (
									<Trans>Bonus points per purchase</Trans>
								) : (
									<Trans>Bonus points per matching item</Trans>
								)
							}
							id="loyalty-promotion-bonus"
							name={fields.bonusPoints.name}
							defaultValue={defaults.bonusPoints}
							error={fields.bonusPoints.errors?.[0] ?? null}
							inputMode="numeric"
							placeholder="10"
							data-testid="loyalty-promotion-bonus"
						/>
					)}
				</div>

				<SelectField
					label={<Trans>Applies to</Trans>}
					id="loyalty-promotion-scope"
					testId="loyalty-promotion-scope"
					options={scopeOptions}
					value={scope}
					onValueChange={(next) => setScope(next as typeof scope)}
					error={fields.scope.errors?.[0] ?? null}
				/>
				{scope === 'items' ? (
					<CatalogPicker
						id="loyalty-promotion-items"
						testId="loyalty-promotion-items"
						label={<Trans>Items</Trans>}
						multiple
						max={LOYALTY_MAX_ITEM_IDS}
						options={catalog.items}
						value={splitCatalogIds(itemsControl.value)}
						onChange={(ids) => itemsControl.change(joinCatalogIds(ids))}
						onClose={() => itemsControl.blur()}
						savedLabels={promotion?.labels.items}
						error={fields.itemIds.errors?.[0] ?? null}
						placeholder={t`Choose items`}
						emptyMessage={<Trans>The menu has no items yet.</Trans>}
					/>
				) : null}
				{scope === 'categories' ? (
					<CatalogPicker
						id="loyalty-promotion-categories"
						testId="loyalty-promotion-categories"
						label={<Trans>Categories</Trans>}
						hint={t`Items listed directly in these categories.`}
						multiple
						max={LOYALTY_MAX_CATEGORY_IDS}
						options={catalog.categories}
						value={splitCatalogIds(categoriesControl.value)}
						onChange={(ids) => categoriesControl.change(joinCatalogIds(ids))}
						onClose={() => categoriesControl.blur()}
						savedLabels={promotion?.labels.categories}
						error={fields.categoryIds.errors?.[0] ?? null}
						placeholder={t`Choose categories`}
						emptyMessage={<Trans>The menu has no categories yet.</Trans>}
					/>
				) : null}

				<fieldset className="flex flex-col gap-3">
					<legend className="text-sm font-medium">
						<Trans>When</Trans>
					</legend>
					<p
						className="text-muted-foreground text-xs"
						data-testid="loyalty-promotion-timezone"
					>
						<Trans>
							All dates and times are in the program's time zone:{' '}
							<bdi dir="ltr">{timeZone}</bdi>.
						</Trans>
					</p>
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<TextField
							label={<Trans>Starts</Trans>}
							optional
							id="loyalty-promotion-starts"
							name={fields.startsAt.name}
							type="datetime-local"
							defaultValue={defaults.startsAt}
							error={fields.startsAt.errors?.[0] ?? null}
							data-testid="loyalty-promotion-starts"
						/>
						<TextField
							label={<Trans>Ends</Trans>}
							optional
							id="loyalty-promotion-ends"
							name={fields.endsAt.name}
							type="datetime-local"
							defaultValue={defaults.endsAt}
							error={fields.endsAt.errors?.[0] ?? null}
							data-testid="loyalty-promotion-ends"
						/>
					</div>
					<Field orientation="horizontal">
						<Checkbox
							id="loyalty-promotion-weekly"
							checked={weekly}
							onCheckedChange={(next) => setWeekly(next === true)}
							data-testid="loyalty-promotion-weekly"
						/>
						<FieldLabel htmlFor="loyalty-promotion-weekly">
							<Trans>Only on certain days and hours</Trans>
						</FieldLabel>
					</Field>
					{weekly ? (
						<div className="flex flex-col gap-3">
							<div className="flex flex-col gap-1">
								<ToggleGroup
									multiple
									variant="outline"
									spacing={1}
									aria-label={t`Days of the week`}
									value={weekdays}
									onValueChange={(next) => setWeekdays([...next].sort())}
									data-testid="loyalty-promotion-weekdays"
								>
									{WEEKDAY_VALUES.map((day) => (
										<ToggleGroupItem
											key={day}
											value={day}
											data-testid={`loyalty-promotion-weekday-${day}`}
										>
											{weekdayNames[day]}
										</ToggleGroupItem>
									))}
								</ToggleGroup>
								{fields.weekdays.errors?.[0] ? (
									<p
										role="alert"
										className="text-destructive text-sm"
										data-testid="loyalty-promotion-weekdays-error"
									>
										{fields.weekdays.errors[0]}
									</p>
								) : null}
							</div>
							<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
								<TextField
									label={<Trans>From</Trans>}
									id="loyalty-promotion-from"
									name={fields.fromTime.name}
									type="time"
									defaultValue={defaults.fromTime}
									error={fields.fromTime.errors?.[0] ?? null}
									data-testid="loyalty-promotion-from"
								/>
								<TextField
									label={<Trans>Until</Trans>}
									hint={t`00:00 means the end of the day.`}
									id="loyalty-promotion-to"
									name={fields.toTime.name}
									type="time"
									defaultValue={defaults.toTime}
									error={fields.toTime.errors?.[0] ?? null}
									data-testid="loyalty-promotion-to"
								/>
							</div>
						</div>
					) : null}
				</fieldset>

				{showLocations ? (
					<fieldset className="flex flex-col gap-3">
						<legend className="text-sm font-medium">
							<Trans>Where</Trans>
						</legend>
						<SelectField
							label={<Trans>Locations</Trans>}
							id="loyalty-promotion-location-mode"
							testId="loyalty-promotion-location-mode"
							options={[
								{ value: 'all', label: t`All locations` },
								{ value: 'selected', label: t`Selected locations` },
							]}
							value={locationMode}
							onValueChange={(next) =>
								setLocationMode(next as typeof locationMode)
							}
						/>
						{locationMode === 'selected' ? (
							<div
								className="flex flex-col gap-2"
								data-testid="loyalty-promotion-locations"
							>
								{locations.map((location) => (
									<Field key={location.id} orientation="horizontal">
										<Checkbox
											id={`loyalty-promotion-location-${location.id}`}
											checked={locationIds.includes(location.id)}
											onCheckedChange={(next) =>
												setLocationIds((current) =>
													next === true
														? [...current, location.id]
														: current.filter((entry) => entry !== location.id),
												)
											}
										/>
										<FieldLabel
											htmlFor={`loyalty-promotion-location-${location.id}`}
										>
											{location.name}
										</FieldLabel>
									</Field>
								))}
								{fields.locationIds.errors?.[0] ? (
									<p role="alert" className="text-destructive text-sm">
										{fields.locationIds.errors[0]}
									</p>
								) : null}
							</div>
						) : null}
					</fieldset>
				) : null}

				<TextField
					label={<Trans>Most bonus points per purchase</Trans>}
					optional
					hint={t`A cap on what one purchase can get from this promotion.`}
					id="loyalty-promotion-cap"
					name={fields.maxPoints.name}
					defaultValue={defaults.maxPoints}
					error={fields.maxPoints.errors?.[0] ?? null}
					inputMode="numeric"
					data-testid="loyalty-promotion-cap"
				/>

				<Field orientation="horizontal">
					<Switch
						id="loyalty-promotion-enabled"
						checked={enabled}
						onCheckedChange={setEnabled}
						data-testid="loyalty-promotion-enabled"
					/>
					<div className="flex flex-col gap-0.5">
						<FieldLabel htmlFor="loyalty-promotion-enabled">
							<Trans>Turned on</Trans>
						</FieldLabel>
						<FieldDescription>
							<Trans>A promotion that is off gives no bonus.</Trans>
						</FieldDescription>
					</div>
				</Field>
			</div>

			<div
				className="bg-muted text-muted-foreground rounded-md px-3 py-2 text-sm"
				data-testid="loyalty-promotion-example"
				aria-live="polite"
			>
				{exampleText ?? (
					<Trans>Fill in the fields above to see an example.</Trans>
				)}
			</div>

			<ErrorList id={form.errorId} errors={form.errors} />

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
					data-testid="loyalty-promotion-save"
				>
					{submitting ? (
						<Trans>Saving…</Trans>
					) : promotion ? (
						<Trans>Save changes</Trans>
					) : (
						<Trans>Create promotion</Trans>
					)}
				</Button>
			</DialogFooter>
		</form>
	)
}
