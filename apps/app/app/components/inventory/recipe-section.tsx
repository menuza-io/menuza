import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	type FoodCostStatus,
	listItemsResultSchema,
	type PlateCost,
	type RecipeOwnerKind,
	recipeResultSchema,
} from '@repo/inventory'
import { Alert, AlertAction, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { QuantityStepper } from '@repo/ui/quantity-stepper'
import { Skeleton } from '@repo/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { type z } from 'zod'
import {
	useInventoryTargetFoodCostBp,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import {
	RecipeLines,
	type RecipeLineCost,
} from '#app/components/inventory/recipe-lines.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import {
	entryStep,
	formatMoney,
	unitChoices,
} from '#app/utils/inventory/format.ts'
import {
	isRecipesUnavailable,
	isStaleVersion,
	recipeSaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import {
	buildPutRecipe,
	draftFromRecipe,
	emptyDraft,
	formatPercentBp,
	hasProblem,
	isRecipeDirty,
	type KnownItem,
	plateView,
	type PlateView,
	type RecipeDraft,
	recipeProblems,
	setMode,
} from '#app/utils/inventory/recipe-form.ts'

type RecipeResult = z.infer<typeof recipeResultSchema>

export type RecipeSectionProps = {
	ownerKind: RecipeOwnerKind
	ownerId: string
	idPrefix: string
	canEdit: boolean
	/** The member may type a cost per dish (cost grant). */
	canTypeCost: boolean
	locationId: string
	currency: string
	/** The menu price in minor units, when a cost summary should compare with it. */
	priceMinor?: number | null
	/** Show Cost to make, Price and Food cost (dishes and sizes). */
	showSummary?: boolean
	/** The cost to show instead of the recipe's own (a size that is a multiple). */
	plateOverride?: PlateCost
	/** Called when the region says there are no recipes for this member. */
	onHidden?: () => void
	/** Called after a save or a clear. */
	onSaved?: () => void
	/** A made item's own facts: its base unit and named units (for "Makes"). */
	madeItem?: KnownItem
	/** Text above the ingredients (what the recipe means here). */
	intro?: ReactNode
	/** Shown under the ingredients (the pizza halves note). */
	footnote?: ReactNode
	addLabel?: string
	/** A heading for the section; omitted when a frame already has one. */
	heading?: ReactNode
	/** Hide the section's own frame (it sits inside another panel). */
	bare?: boolean
}

const STATUS_STYLE: Record<FoodCostStatus, string> = {
	good: 'bg-success',
	watch: 'bg-warning',
	high: 'bg-destructive',
}

/** The status dot beside a food cost percentage, with a text name for screen readers. */
export function FoodCostDot({ status }: { status: FoodCostStatus }) {
	const { t } = useLingui()
	const label =
		status === 'good'
			? t`On target`
			: status === 'watch'
				? t`A little over target`
				: t`Over target`
	return (
		<span
			role="img"
			aria-label={label}
			title={label}
			className={`inline-block size-2.5 shrink-0 rounded-full ${STATUS_STYLE[status]}`}
			data-testid={`food-cost-dot-${status}`}
		/>
	)
}

/**
 * One recipe, loaded and saved by itself through the inventory client: the
 * ingredients (or a size multiple, or a typed cost), its own Save and Clear,
 * and what it costs. It never rides on a surrounding form: the recipe is
 * regional data and goes browser-direct to the region.
 */
export function RecipeSection({
	ownerKind,
	ownerId,
	idPrefix,
	canEdit,
	canTypeCost,
	locationId,
	currency,
	priceMinor = null,
	showSummary = false,
	plateOverride,
	onHidden,
	onSaved,
	madeItem,
	intro,
	footnote,
	addLabel,
	heading,
	bare = false,
}: RecipeSectionProps) {
	const { t, i18n } = useLingui()
	const client = useInventoryClient()
	const { request } = client
	const quantity = useQuantityFormat()
	const targetBp = useInventoryTargetFoodCostBp()
	const system = quantity.system

	const query = useInventoryQuery(
		`/recipes?ownerKind=${encodeURIComponent(ownerKind)}&ownerId=${encodeURIComponent(ownerId)}`,
		recipeResultSchema,
	)
	const { reload } = query
	const known = useRef(new Map<string, KnownItem>())
	if (madeItem) known.current.set(madeItem.id, madeItem)

	const [loaded, setLoaded] = useState<RecipeResult | null>(null)
	const [draft, setDraft] = useState<RecipeDraft>(() => emptyDraft(ownerKind))
	const [baseline, setBaseline] = useState<RecipeDraft>(() =>
		emptyDraft(ownerKind),
	)
	const [attempted, setAttempted] = useState(false)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [stale, setStale] = useState(false)
	const [clearing, setClearing] = useState(false)
	const typedCostId = useId()
	const makesId = useId()

	function apply(result: RecipeResult) {
		setLoaded(result)
		const next = draftFromRecipe(result.recipe, ownerKind, {
			system,
			currency,
			known: known.current,
		})
		setDraft(next)
		setBaseline(next)
		setAttempted(false)
	}

	useEffect(() => {
		if (query.data) apply(query.data)
		// `apply` only reads state setters and stable props.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [query.data])

	const unavailable = query.error !== null && isRecipesUnavailable(query.error)
	useEffect(() => {
		if (unavailable) onHidden?.()
	}, [unavailable, onHidden])

	// Named units of the saved ingredients come from one quiet read of the
	// catalogue; without it a line is still editable in standard units.
	const hasLines = (loaded?.recipe?.lines.length ?? 0) > 0
	useEffect(() => {
		if (!hasLines) return
		let live = true
		request(`/items?locationId=${encodeURIComponent(locationId)}&limit=200`)
			.then((body) => {
				const parsed = listItemsResultSchema.safeParse(body)
				if (!live || !parsed.success) return
				for (const item of parsed.data.items) {
					known.current.set(item.id, {
						id: item.id,
						name: item.name,
						baseUnit: item.baseUnit,
						units: item.units,
					})
				}
				setDraft((current) => ({
					...current,
					lines: current.lines.map((line) => ({
						...line,
						units:
							line.units.length > 0
								? line.units
								: (known.current.get(line.itemId ?? '')?.units ?? []),
					})),
				}))
			})
			.catch(() => {})
		return () => {
			live = false
		}
	}, [hasLines, request, locationId])

	if (unavailable) return null

	if (query.loading && !loaded) {
		return (
			<div
				role="status"
				className="flex flex-col gap-3"
				data-testid={`${idPrefix}-loading`}
			>
				<span className="sr-only">
					<Trans>Loading ingredients</Trans>
				</span>
				<Skeleton className="h-8 w-1/2" />
				<Skeleton className="h-20 w-full" />
			</div>
		)
	}
	if (query.error && !loaded) {
		return (
			<Alert variant="destructive" data-testid={`${idPrefix}-error`}>
				<AlertDescription>
					<Trans>
						We could not load the ingredients. Check your connection and try
						again.
					</Trans>
				</AlertDescription>
				<AlertAction>
					<Button type="button" variant="outline" onClick={reload}>
						<Trans>Try again</Trans>
					</Button>
				</AlertAction>
			</Alert>
		)
	}

	const typedLocked = draft.mode === 'typed' && !canTypeCost
	const readOnly = !canEdit
	const problems = attempted
		? recipeProblems(draft, { ownerKind, currency })
		: []
	const dirty = isRecipeDirty(draft, baseline)
	const version = loaded?.version ?? 0
	const hasRecipe = loaded?.recipe != null

	const lineCosts = new Map<string, RecipeLineCost>()
	for (const line of loaded?.recipe?.lines ?? []) {
		lineCosts.set(line.itemId, {
			costMinor: line.costMinor,
			priced: line.priced,
		})
	}
	const plate = plateOverride ?? loaded?.recipe?.plate
	const view = showSummary
		? plateView(plate, { priceMinor, targetBp, currency })
		: null

	async function save() {
		if (saving || readOnly) return
		setAttempted(true)
		const body = buildPutRecipe(draft, {
			ownerKind,
			ownerId,
			expectedVersion: version,
			currency,
		})
		if (!body) return
		setSaving(true)
		setError(null)
		setStale(false)
		try {
			const result = recipeResultSchema.parse(
				await request('/recipes', {
					method: 'PUT',
					body: JSON.stringify(body),
				}),
			)
			apply(result)
			toast.success(t`Ingredients saved.`)
			onSaved?.()
		} catch (caught) {
			if (isStaleVersion(caught)) {
				setStale(true)
				reload()
			} else if (isRecipesUnavailable(caught) && !isForbiddenWrite(caught)) {
				onHidden?.()
			} else {
				setError(i18n._(recipeSaveErrorMessage(caught)))
			}
		} finally {
			setSaving(false)
		}
	}

	async function clear() {
		setSaving(true)
		setError(null)
		setStale(false)
		try {
			const result = recipeResultSchema.parse(
				await request('/recipes/clear', {
					method: 'POST',
					body: JSON.stringify({
						ownerKind,
						ownerId,
						expectedVersion: version,
					}),
				}),
			)
			setClearing(false)
			apply(result)
			toast.success(t`Recipe cleared.`)
			onSaved?.()
		} catch (caught) {
			setClearing(false)
			if (isStaleVersion(caught)) {
				setStale(true)
				reload()
			} else {
				setError(i18n._(recipeSaveErrorMessage(caught)))
			}
		} finally {
			setSaving(false)
		}
	}

	const makesUnits = madeItem
		? unitChoices(madeItem.baseUnit, madeItem.units, system)
		: []

	const body = (
		<div
			className="flex flex-col gap-4"
			data-testid={`${idPrefix}-section`}
			onKeyDown={(event) => {
				// The menu form around this panel must not submit on Enter.
				if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
					event.preventDefault()
				}
			}}
		>
			{heading ? <h3 className="text-sm font-semibold">{heading}</h3> : null}
			{intro ? <p className="text-muted-foreground text-sm">{intro}</p> : null}

			{stale ? (
				<Alert data-testid={`${idPrefix}-stale`}>
					<AlertDescription>
						<Trans>
							Someone changed this while you were editing, so we loaded their
							version. Check it and save again.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}
			{error ? (
				<Alert variant="destructive" data-testid={`${idPrefix}-save-error`}>
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			{ownerKind === 'variant' ? (
				<ToggleGroup
					aria-label={t`How this size is made`}
					variant="outline"
					value={[draft.mode === 'multiplier' ? 'multiplier' : 'own']}
					disabled={readOnly}
					onValueChange={(next) => {
						if (next[0] === 'multiplier') setDraft(setMode(draft, 'multiplier'))
						else if (next[0] === 'own') setDraft(setMode(draft, 'lines'))
					}}
					className="flex-wrap"
				>
					<ToggleGroupItem
						value="multiplier"
						className="h-11 md:h-8"
						data-testid={`${idPrefix}-mode-multiplier`}
					>
						<Trans>Same recipe</Trans>
					</ToggleGroupItem>
					<ToggleGroupItem
						value="own"
						className="h-11 md:h-8"
						data-testid={`${idPrefix}-mode-own`}
					>
						<Trans>Own ingredients</Trans>
					</ToggleGroupItem>
				</ToggleGroup>
			) : null}

			{draft.mode === 'multiplier' ? (
				<Field data-invalid={hasProblem(problems, 'multiplier') || undefined}>
					<FieldLabel htmlFor={`${idPrefix}-multiplier`}>
						<Trans>Times the dish recipe</Trans>
					</FieldLabel>
					<div className="flex items-center gap-2">
						<QuantityStepper
							id={`${idPrefix}-multiplier`}
							value={draft.multiplier}
							onValueChange={(multiplier) => setDraft({ ...draft, multiplier })}
							step={0.25}
							min={0.01}
							max={100}
							decrementLabel={t`Less`}
							incrementLabel={t`More`}
							disabled={readOnly}
							invalid={hasProblem(problems, 'multiplier')}
							data-testid={`${idPrefix}-multiplier`}
						/>
						<bdi dir="ltr" className="text-muted-foreground text-sm">
							×
						</bdi>
					</div>
					<FieldDescription>
						<Trans>
							1× uses the same ingredients as the dish. 2× doubles them.
						</Trans>
					</FieldDescription>
					{hasProblem(problems, 'multiplier') ? (
						<FieldError>
							<Trans>Enter a number from 0.01 to 100.</Trans>
						</FieldError>
					) : null}
				</Field>
			) : draft.mode === 'typed' ? (
				<div className="flex flex-col gap-2" data-testid={`${idPrefix}-typed`}>
					{typedLocked ? (
						<p className="text-muted-foreground text-sm">
							<Trans>
								This one uses a cost somebody typed. You need cost access to see
								or change it.
							</Trans>
						</p>
					) : (
						<Field
							data-invalid={hasProblem(problems, 'typed_cost') || undefined}
						>
							<FieldLabel htmlFor={typedCostId}>
								<Trans>Cost to make one (typed)</Trans>
							</FieldLabel>
							<Input
								id={typedCostId}
								inputMode="decimal"
								value={draft.typedCostText}
								onChange={(event) =>
									setDraft({ ...draft, typedCostText: event.target.value })
								}
								disabled={readOnly}
								aria-invalid={hasProblem(problems, 'typed_cost') || undefined}
								className="h-11 w-40 tabular-nums md:h-8"
								data-testid={`${idPrefix}-typed-cost`}
							/>
							<FieldDescription>
								<Trans>
									Shown as typed. It is not worked out from ingredients.
								</Trans>{' '}
								<bdi dir="ltr">{currency}</bdi>
							</FieldDescription>
							{hasProblem(problems, 'typed_cost') ? (
								<FieldError>
									<Trans>Enter an amount, for example 4.50.</Trans>
								</FieldError>
							) : null}
						</Field>
					)}
					{readOnly ? null : (
						<Button
							type="button"
							variant="link"
							size="sm"
							className="self-start px-0"
							onClick={() => setDraft(setMode(draft, 'lines'))}
							data-testid={`${idPrefix}-use-ingredients`}
						>
							<Trans>Use ingredients instead</Trans>
						</Button>
					)}
				</div>
			) : (
				<>
					{ownerKind === 'made_item' && madeItem ? (
						<Field data-invalid={hasProblem(problems, 'makes') || undefined}>
							<FieldLabel htmlFor={makesId}>
								<Trans>Makes</Trans>
							</FieldLabel>
							<div className="flex flex-wrap items-center gap-2">
								<QuantityStepper
									id={makesId}
									value={draft.makesAmount}
									onValueChange={(makesAmount) =>
										setDraft({ ...draft, makesAmount })
									}
									step={entryStep(draft.makesUnit)}
									decrementLabel={t`Less`}
									incrementLabel={t`More`}
									disabled={readOnly}
									invalid={hasProblem(problems, 'makes')}
									data-testid={`${idPrefix}-makes-amount`}
								/>
								<FilterSelect
									label={t`Unit`}
									options={makesUnits.map((unit) => ({
										value: unit,
										label: quantity.unitName(unit, madeItem.units),
									}))}
									value={draft.makesUnit ?? ''}
									onValueChange={(makesUnit) =>
										setDraft({ ...draft, makesUnit })
									}
									className="w-28"
									testId={`${idPrefix}-makes-unit`}
								/>
							</div>
							{hasProblem(problems, 'makes') ? (
								<FieldError>
									<Trans>Say how much one batch makes.</Trans>
								</FieldError>
							) : null}
						</Field>
					) : null}
					{draft.lines.length === 0 ? (
						<p
							className="text-muted-foreground text-sm"
							data-testid={`${idPrefix}-none`}
						>
							{readOnly ? (
								<Trans>No ingredients yet.</Trans>
							) : (
								<Trans>
									No ingredients yet. Add what goes in to see what it costs.
								</Trans>
							)}
						</p>
					) : null}
					<RecipeLines
						draft={draft}
						onDraftChange={setDraft}
						problems={problems}
						readOnly={readOnly}
						allowReplace={ownerKind === 'option'}
						client={client}
						locationId={locationId}
						idPrefix={idPrefix}
						lineCosts={lineCosts}
						currency={currency}
						addLabel={addLabel}
					/>
					{hasProblem(problems, 'empty') ? (
						<p className="text-destructive text-sm" role="alert">
							<Trans>Add at least one ingredient.</Trans>
						</p>
					) : null}
					{hasProblem(problems, 'duplicate') ? (
						<p className="text-destructive text-sm" role="alert">
							<Trans>Each ingredient can be listed once.</Trans>
						</p>
					) : null}
					{canTypeCost && !readOnly && draft.lines.length === 0 ? (
						<Button
							type="button"
							variant="link"
							size="sm"
							className="self-start px-0"
							onClick={() => setDraft(setMode(draft, 'typed'))}
							data-testid={`${idPrefix}-use-typed`}
						>
							<Trans>Type a cost instead</Trans>
						</Button>
					) : null}
				</>
			)}

			{footnote ? (
				<p className="text-muted-foreground text-xs">{footnote}</p>
			) : null}

			{view ? (
				<RecipeSummary
					view={view}
					priceMinor={priceMinor}
					targetBp={targetBp}
					currency={currency}
					dirty={dirty}
					idPrefix={idPrefix}
				/>
			) : null}

			{readOnly ? null : (
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						onClick={() => void save()}
						disabled={saving || !dirty || typedLocked}
						data-testid={`${idPrefix}-save`}
					>
						{saving ? <Trans>Saving…</Trans> : <Trans>Save ingredients</Trans>}
					</Button>
					{hasRecipe ? (
						<Button
							type="button"
							variant="outline"
							disabled={saving}
							onClick={() => setClearing(true)}
							data-testid={`${idPrefix}-clear`}
						>
							<Trans>Clear recipe</Trans>
						</Button>
					) : null}
					{dirty ? (
						<span className="text-muted-foreground text-xs">
							<Trans>You have changes that are not saved.</Trans>
						</span>
					) : null}
				</div>
			)}

			<AlertDialog
				open={clearing}
				onOpenChange={(next) => {
					if (!saving) setClearing(next)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Clear this recipe?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								From now on it has no ingredients and no cost. Sales made before
								keep the recipe they used.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={saving}>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={saving}
							onClick={() => void clear()}
							data-testid={`${idPrefix}-clear-confirm`}
						>
							<Trans>Clear recipe</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)

	return bare ? body : <div className="rounded-lg border p-4">{body}</div>
}

function isForbiddenWrite(error: unknown): boolean {
	// A 403 on a SAVE is a missing grant (shown as a sentence), not a reason
	// to make the whole panel disappear.
	return (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		(error as { status: number }).status === 403
	)
}

/** Cost to make, price, food cost, the target and the price that would hit it. */
export function RecipeSummary({
	view,
	priceMinor,
	targetBp,
	currency,
	dirty,
	idPrefix,
}: {
	view: PlateView
	priceMinor: number | null
	targetBp: number | null
	currency: string
	dirty: boolean
	idPrefix: string
}) {
	const { i18n } = useLingui()
	const money = (minor: number) =>
		formatMoney(minor, view.currency || currency, i18n.locale)
	// Without the cost grant the region sends no money: say nothing about it.
	if (!view.showMoney && view.state !== 'unknown' && view.state !== 'invalid') {
		return null
	}
	return (
		<div
			className="bg-muted/40 flex flex-col gap-2 rounded-lg p-3"
			data-testid={`${idPrefix}-summary`}
		>
			{view.state === 'unknown' ? (
				<p className="text-sm" data-testid={`${idPrefix}-unpriced`}>
					<Trans>
						No ingredient has a price yet. Add a delivery to see what this
						costs.
					</Trans>
				</p>
			) : view.state === 'invalid' ? (
				<p className="text-destructive text-sm" role="alert">
					<Trans>
						This recipe loops or nests too deeply, so its cost cannot be worked
						out.
					</Trans>
				</p>
			) : (
				<>
					<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
						<dt className="text-muted-foreground">
							{view.typed ? (
								<Trans>Cost to make (typed)</Trans>
							) : view.state === 'partial' ? (
								<Trans>Cost to make (at least)</Trans>
							) : (
								<Trans>Cost to make</Trans>
							)}
						</dt>
						<dd className="tabular-nums" data-testid={`${idPrefix}-cost`}>
							<bdi dir="ltr">{money(view.costMinor!)}</bdi>
						</dd>
						{priceMinor !== null && priceMinor > 0 ? (
							<>
								<dt className="text-muted-foreground">
									<Trans>Price</Trans>
								</dt>
								<dd className="tabular-nums" data-testid={`${idPrefix}-price`}>
									<bdi dir="ltr">{money(priceMinor)}</bdi>
								</dd>
							</>
						) : null}
						{view.foodCostBp !== null ? (
							<>
								<dt className="text-muted-foreground">
									<Trans>Food cost</Trans>
								</dt>
								<dd
									className="flex items-center gap-2 tabular-nums"
									data-testid={`${idPrefix}-food-cost`}
								>
									<bdi dir="ltr">
										{formatPercentBp(view.foodCostBp, i18n.locale)}
									</bdi>
									{view.status ? <FoodCostDot status={view.status} /> : null}
								</dd>
							</>
						) : null}
						{targetBp !== null ? (
							<>
								<dt className="text-muted-foreground">
									<Trans>Target</Trans>
								</dt>
								<dd className="tabular-nums">
									<bdi dir="ltr">{formatPercentBp(targetBp, i18n.locale)}</bdi>
								</dd>
							</>
						) : null}
						{view.priceForTargetMinor !== null ? (
							<>
								<dt className="text-muted-foreground">
									<Trans>Price for target</Trans>
								</dt>
								<dd
									className="tabular-nums"
									data-testid={`${idPrefix}-price-for-target`}
								>
									<bdi dir="ltr">{money(view.priceForTargetMinor)}</bdi>
								</dd>
							</>
						) : null}
					</dl>
					{view.state === 'partial' ? (
						<p
							className="text-muted-foreground text-xs"
							data-testid={`${idPrefix}-unpriced`}
						>
							<Plural
								value={view.unpricedCount}
								one="# ingredient has no price yet: add a delivery to price it."
								other="# ingredients have no price yet: add a delivery to price them."
							/>
						</p>
					) : null}
				</>
			)}
			{dirty ? (
				<p className="text-muted-foreground text-xs">
					<Trans>Save to update the cost.</Trans>
				</p>
			) : null}
		</div>
	)
}
