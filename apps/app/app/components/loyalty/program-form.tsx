import { getFormProps, useForm, useInputControl } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod/v4'
import { type MessageDescriptor } from '@lingui/core'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	LOYALTY_MAX_CATEGORY_IDS,
	LOYALTY_MAX_ITEM_IDS,
	LOYALTY_MAX_RULE_POINTS,
	LOYALTY_MAX_SPEND_PER_MINOR,
	loyaltyProgramConfigSchema,
	type LoyaltyEarningMethod,
	type LoyaltyEarningRule,
	type LoyaltyOperatorProgram,
	type LoyaltyProgramConfig,
	type LoyaltyUnitLabel,
} from '@repo/loyalty'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { ErrorList } from '#app/components/forms.tsx'
import {
	SelectField,
	TextAreaField,
	TextField,
} from '#app/components/staff/controls.tsx'
import {
	catalogLabelsFor,
	joinCatalogIds,
	splitCatalogIds,
	type LoyaltyCatalog,
} from '#app/utils/loyalty/catalog.ts'
import {
	LOYALTY_UNIT_LABEL_LABELS,
	loyaltyEnumLabel,
} from '#app/utils/loyalty/loyalty-labels.ts'
import {
	isUsableTimeZone,
	minorToMoneyInput,
} from '#app/utils/loyalty/loyalty-view.ts'
import {
	currencyExponent,
	minorToMajor,
	parseMoneyToMinor,
	parseWholeNumber,
} from '#app/utils/money-input.ts'
import { CatalogPicker } from './catalog-picker.tsx'

type ProgramFormValues = {
	name: string
	unitLabel: LoyaltyUnitLabel
	currency: string
	timeZone: string
	minimumSpend: string
	earningMethod: LoyaltyEarningMethod
	earnPoints: string
	earnPer: string
	earnItemIds: string
	earnCategoryIds: string
	terms: string
}

function programDefaults(
	program: LoyaltyOperatorProgram | null,
	defaultTimeZone: string,
): ProgramFormValues {
	const config = program?.current.config
	const earning = config?.earning
	return {
		name: config?.name ?? '',
		unitLabel: config?.unitLabel ?? 'points',
		currency: config?.currency ?? '',
		timeZone: config?.timeZone ?? defaultTimeZone,
		minimumSpend:
			config && config.minimumSpendMinor > 0
				? minorToMoneyInput(config.minimumSpendMinor, config.currency)
				: '',
		earningMethod: earning?.method ?? 'spend',
		earnPoints: earning ? String(earning.points) : '1',
		earnPer:
			earning?.method === 'spend'
				? minorToMoneyInput(earning.perMinor, config?.currency)
				: '1.00',
		earnItemIds:
			earning?.method === 'items' ? joinCatalogIds(earning.itemIds) : '',
		earnCategoryIds:
			earning?.method === 'categories'
				? joinCatalogIds(earning.categoryIds)
				: '',
		terms: config?.terms ?? '',
	}
}

/**
 * The program editor. Saving sends the whole configuration as a new version;
 * chosen items and categories carry the menu names captured at save time.
 */
export function ProgramForm({
	program,
	catalog,
	defaultTimeZone,
	canManage,
	saving,
	onSave,
	onDirtyChange,
}: {
	program: LoyaltyOperatorProgram | null
	catalog: LoyaltyCatalog
	defaultTimeZone: string
	canManage: boolean
	saving: boolean
	onSave: (config: LoyaltyProgramConfig, expectedVersion: number | null) => void
	/** Reports whether the form holds edits that are not saved yet. */
	onDirtyChange?: (dirty: boolean) => void
}) {
	const { t, i18n } = useLingui()
	const tx = useCallback((d: MessageDescriptor) => i18n._(d), [i18n])
	const defaults = useMemo(
		() => programDefaults(program, defaultTimeZone),
		[program, defaultTimeZone],
	)
	const [unitLabel, setUnitLabel] = useState<LoyaltyUnitLabel>(
		defaults.unitLabel,
	)
	const [earningMethod, setEarningMethod] = useState<LoyaltyEarningMethod>(
		defaults.earningMethod,
	)
	const [submitError, setSubmitError] = useState<string | null>(null)
	const savedLabels = program?.current.config.labels ?? {
		items: {},
		categories: {},
	}

	// Conform turns an empty or missing field into undefined, so every text
	// field defaults to '' and keeps its own message instead of "Required".
	const schema = useMemo(() => {
		const mostPerIn = (currency: string) => {
			const exponent = currencyExponent(currency)
			return new Intl.NumberFormat(i18n.locale, {
				minimumFractionDigits: exponent,
				maximumFractionDigits: exponent,
			}).format(minorToMajor(LOYALTY_MAX_SPEND_PER_MINOR, currency))
		}
		return z
			.object({
				name: z
					.string()
					.trim()
					.min(1, t`Enter a program name.`)
					.max(80, t`Keep the name under 80 characters.`)
					.prefault(''),
				unitLabel: z.enum(['points', 'stars']),
				currency: z
					.string()
					.trim()
					.toUpperCase()
					.regex(
						/^[A-Z]{3}$/,
						t`Use a three-letter currency code, like USD or SAR.`,
					)
					.prefault(''),
				timeZone: z
					.string()
					.trim()
					.min(1, t`Enter a time zone.`)
					.refine(
						isUsableTimeZone,
						t`Enter a valid IANA time zone, like America/New_York.`,
					)
					.prefault(''),
				minimumSpend: z.string().trim().prefault(''),
				earningMethod: z.enum(['spend', 'visit', 'items', 'categories']),
				earnPoints: z
					.string()
					.trim()
					.refine(
						(value) =>
							parseWholeNumber(value, {
								min: 1,
								max: LOYALTY_MAX_RULE_POINTS,
							}) !== null,
						t`Enter a whole number of points, at least 1.`,
					)
					.prefault(''),
				earnPer: z.string().trim().prefault(''),
				earnItemIds: z.string().prefault(''),
				earnCategoryIds: z.string().prefault(''),
				terms: z
					.string()
					.trim()
					.max(4000, t`Keep the terms under 4000 characters.`)
					.prefault(''),
			})
			.superRefine((value, ctx) => {
				const currency = value.currency
				if (
					value.minimumSpend !== '' &&
					parseMoneyToMinor(value.minimumSpend, { currency }) === null
				) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ['minimumSpend'],
						message: t`Enter an amount like 12.50, or leave empty for no minimum.`,
					})
				}
				if (value.earningMethod === 'spend') {
					const perMinor = parseMoneyToMinor(value.earnPer, {
						min: 1,
						currency,
					})
					if (perMinor === null) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							path: ['earnPer'],
							message: t`Enter the spend that earns the points, like 10.00.`,
						})
					} else if (perMinor > LOYALTY_MAX_SPEND_PER_MINOR) {
						const mostPer = mostPerIn(currency)
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							path: ['earnPer'],
							message: t`The spend that earns the points can be at most ${mostPer}.`,
						})
					} else {
						// The region refuses more than one point per minor unit of spend.
						const points = parseWholeNumber(value.earnPoints, {
							min: 1,
							max: LOYALTY_MAX_RULE_POINTS,
						})
						if (points !== null && points > perMinor) {
							ctx.addIssue({
								code: z.ZodIssueCode.custom,
								path: ['earnPoints'],
								message: t`Use at most ${plural(perMinor, { one: '# point', other: '# points' })} for this spend.`,
							})
						}
					}
				}
				if (
					value.earningMethod === 'items' &&
					splitCatalogIds(value.earnItemIds).length === 0
				) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ['earnItemIds'],
						message: t`Choose at least one item.`,
					})
				}
				if (
					value.earningMethod === 'categories' &&
					splitCatalogIds(value.earnCategoryIds).length === 0
				) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ['earnCategoryIds'],
						message: t`Choose at least one category.`,
					})
				}
			})
	}, [t, i18n.locale])

	const [form, fields] = useForm({
		id: 'loyalty-program-form',
		defaultValue: defaults,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema })
		},
		shouldValidate: 'onBlur',
		shouldRevalidate: 'onInput',
		onSubmit(event, { submission }) {
			event.preventDefault()
			if (submission?.status !== 'success') return
			const value = submission.value
			const points = parseWholeNumber(value.earnPoints)!
			const earning: LoyaltyEarningRule =
				value.earningMethod === 'spend'
					? {
							method: 'spend',
							points,
							perMinor: parseMoneyToMinor(value.earnPer, {
								min: 1,
								currency: value.currency,
							})!,
						}
					: value.earningMethod === 'visit'
						? { method: 'visit', points }
						: value.earningMethod === 'items'
							? {
									method: 'items',
									points,
									itemIds: splitCatalogIds(value.earnItemIds),
								}
							: {
									method: 'categories',
									points,
									categoryIds: splitCatalogIds(value.earnCategoryIds),
								}
			const config: LoyaltyProgramConfig = {
				name: value.name,
				unitLabel: value.unitLabel,
				currency: value.currency,
				timeZone: value.timeZone,
				minimumSpendMinor:
					parseMoneyToMinor(value.minimumSpend, { currency: value.currency }) ??
					0,
				earning,
				terms: value.terms,
				labels: {
					items:
						earning.method === 'items'
							? catalogLabelsFor(
									earning.itemIds,
									catalog.items,
									savedLabels.items,
								)
							: {},
					categories:
						earning.method === 'categories'
							? catalogLabelsFor(
									earning.categoryIds,
									catalog.categories,
									savedLabels.categories,
								)
							: {},
				},
			}
			const checked = loyaltyProgramConfigSchema.safeParse(config)
			if (!checked.success) {
				setSubmitError(t`Check the fields and try again.`)
				return
			}
			setSubmitError(null)
			onSave(checked.data, program?.version ?? null)
		},
	})

	// The two selects live outside conform's tracking (hidden inputs), so they
	// count on their own.
	const dirty =
		form.dirty ||
		unitLabel !== defaults.unitLabel ||
		earningMethod !== defaults.earningMethod
	useEffect(() => {
		onDirtyChange?.(dirty)
	}, [dirty, onDirtyChange])
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

	const itemsControl = useInputControl(fields.earnItemIds)
	const categoriesControl = useInputControl(fields.earnCategoryIds)

	const currencyLocked = program?.currencyLocked ?? false
	const unitLabelText = loyaltyEnumLabel(
		tx,
		LOYALTY_UNIT_LABEL_LABELS,
		unitLabel,
	).toLowerCase()
	const readOnly = !canManage || saving

	return (
		<form
			{...getFormProps(form)}
			className="flex flex-col gap-4"
			data-testid="loyalty-program-form"
		>
			<input type="hidden" name={fields.unitLabel.name} value={unitLabel} />
			<input
				type="hidden"
				name={fields.earningMethod.name}
				value={earningMethod}
			/>
			{currencyLocked ? (
				// A disabled input is not submitted; the locked code still is.
				<input
					type="hidden"
					name={fields.currency.name}
					value={defaults.currency}
				/>
			) : null}

			<Card>
				<CardHeader className="pb-2">
					<CardTitle className="text-base">
						<Trans>Basics</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>The name and units customers see.</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<TextField
						label={<Trans>Program name</Trans>}
						id="loyalty-program-name"
						name={fields.name.name}
						defaultValue={defaults.name}
						error={fields.name.errors?.[0] ?? null}
						disabled={readOnly}
						maxLength={80}
						data-testid="loyalty-program-name"
					/>
					<SelectField
						label={<Trans>Points are called</Trans>}
						id="loyalty-program-unit-label"
						testId="loyalty-program-unit-label"
						options={[
							{ value: 'points', label: t`Points` },
							{ value: 'stars', label: t`Stars` },
						]}
						value={unitLabel}
						onValueChange={(next) => setUnitLabel(next as LoyaltyUnitLabel)}
						error={fields.unitLabel.errors?.[0] ?? null}
						disabled={readOnly}
					/>
					<TextField
						label={<Trans>Currency</Trans>}
						hint={
							currencyLocked
								? t`Locked: the program has been active, so the currency cannot change.`
								: t`Three-letter ISO code. It locks once the program has been active.`
						}
						id="loyalty-program-currency"
						name={currencyLocked ? undefined : fields.currency.name}
						defaultValue={defaults.currency}
						error={fields.currency.errors?.[0] ?? null}
						disabled={readOnly || currencyLocked}
						maxLength={3}
						autoCapitalize="characters"
						placeholder="USD"
						className="sm:max-w-40"
						data-testid="loyalty-program-currency"
					/>
					<TextField
						label={<Trans>Time zone</Trans>}
						hint={t`Decides the local day for visit rewards.`}
						id="loyalty-program-timezone"
						name={fields.timeZone.name}
						defaultValue={defaults.timeZone}
						error={fields.timeZone.errors?.[0] ?? null}
						disabled={readOnly}
						placeholder="America/New_York"
						dir="ltr"
						data-testid="loyalty-program-timezone"
					/>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="pb-2">
					<CardTitle className="text-base">
						<Trans>Earning</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>How a purchase turns into {unitLabelText}.</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<SelectField
						label={<Trans>Customers earn by</Trans>}
						id="loyalty-program-earning-method"
						testId="loyalty-program-earning-method"
						options={[
							{ value: 'spend', label: t`Amount spent` },
							{ value: 'visit', label: t`Each visit` },
							{ value: 'items', label: t`Buying selected items` },
							{
								value: 'categories',
								label: t`Buying from selected categories`,
							},
						]}
						value={earningMethod}
						onValueChange={(next) =>
							setEarningMethod(next as LoyaltyEarningMethod)
						}
						error={fields.earningMethod.errors?.[0] ?? null}
						disabled={readOnly}
					/>
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<TextField
							label={
								earningMethod === 'visit' ? (
									<Trans>Points per visit</Trans>
								) : earningMethod === 'spend' ? (
									<Trans>Points earned</Trans>
								) : (
									<Trans>Points per unit</Trans>
								)
							}
							id="loyalty-program-earn-points"
							name={fields.earnPoints.name}
							defaultValue={defaults.earnPoints}
							error={fields.earnPoints.errors?.[0] ?? null}
							disabled={readOnly}
							inputMode="numeric"
							data-testid="loyalty-program-earn-points"
						/>
						{earningMethod === 'spend' ? (
							<TextField
								label={<Trans>For every</Trans>}
								hint={t`Amount spent that earns the points, for example 10.00.`}
								id="loyalty-program-earn-per"
								name={fields.earnPer.name}
								defaultValue={defaults.earnPer}
								error={fields.earnPer.errors?.[0] ?? null}
								disabled={readOnly}
								inputMode="decimal"
								placeholder="10.00"
								data-testid="loyalty-program-earn-per"
							/>
						) : null}
						{earningMethod === 'items' ? (
							<CatalogPicker
								id="loyalty-program-earn-items"
								testId="loyalty-program-earn-items"
								label={<Trans>Items that earn</Trans>}
								hint={t`Each unit bought earns the points above.`}
								multiple
								max={LOYALTY_MAX_ITEM_IDS}
								options={catalog.items}
								value={splitCatalogIds(itemsControl.value)}
								onChange={(ids) => itemsControl.change(joinCatalogIds(ids))}
								onClose={() => itemsControl.blur()}
								savedLabels={savedLabels.items}
								error={fields.earnItemIds.errors?.[0] ?? null}
								disabled={readOnly}
								placeholder={t`Choose items`}
								emptyMessage={<Trans>The menu has no items yet.</Trans>}
								className="sm:col-span-2"
							/>
						) : null}
						{earningMethod === 'categories' ? (
							<CatalogPicker
								id="loyalty-program-earn-categories"
								testId="loyalty-program-earn-categories"
								label={<Trans>Categories that earn</Trans>}
								hint={t`Items listed directly in a chosen category earn. Choose subcategories separately.`}
								multiple
								max={LOYALTY_MAX_CATEGORY_IDS}
								options={catalog.categories}
								value={splitCatalogIds(categoriesControl.value)}
								onChange={(ids) =>
									categoriesControl.change(joinCatalogIds(ids))
								}
								onClose={() => categoriesControl.blur()}
								savedLabels={savedLabels.categories}
								error={fields.earnCategoryIds.errors?.[0] ?? null}
								disabled={readOnly}
								placeholder={t`Choose categories`}
								emptyMessage={<Trans>The menu has no categories yet.</Trans>}
								className="sm:col-span-2"
							/>
						) : null}
						<TextField
							label={<Trans>Minimum qualifying spend</Trans>}
							optional
							hint={t`Orders below this do not earn. Merchandise after discounts, without tax or tips.`}
							id="loyalty-program-minimum-spend"
							name={fields.minimumSpend.name}
							defaultValue={defaults.minimumSpend}
							error={fields.minimumSpend.errors?.[0] ?? null}
							disabled={readOnly}
							inputMode="decimal"
							placeholder="0.00"
							data-testid="loyalty-program-minimum-spend"
						/>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="pb-2">
					<CardTitle className="text-base">
						<Trans>Terms</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>Shown to customers in their wallet.</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<TextAreaField
						label={<Trans>Program terms</Trans>}
						id="loyalty-program-terms"
						name={fields.terms.name}
						defaultValue={defaults.terms}
						error={fields.terms.errors?.[0] ?? null}
						disabled={readOnly}
						rows={6}
						data-testid="loyalty-program-terms"
					/>
				</CardContent>
			</Card>

			<ErrorList
				id={form.errorId}
				errors={[...(form.errors ?? []), ...(submitError ? [submitError] : [])]}
			/>

			{canManage ? (
				<div className="flex items-center gap-3">
					<Button
						type="submit"
						disabled={saving}
						data-testid="loyalty-program-save"
					>
						{saving ? (
							<Trans>Saving…</Trans>
						) : program ? (
							<Trans>Save changes</Trans>
						) : (
							<Trans>Create program</Trans>
						)}
					</Button>
					<span className="text-muted-foreground text-xs">
						<Trans>
							Saving creates a new version; purchases keep the version they
							earned under.
						</Trans>
					</span>
				</div>
			) : null}
		</form>
	)
}
