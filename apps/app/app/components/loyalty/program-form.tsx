import { getFormProps, useForm, useInputControl } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod/v4'
import { type MessageDescriptor } from '@lingui/core'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	DEFAULT_LOYALTY_EXPIRY_CONFIG,
	DEFAULT_LOYALTY_REFERRAL_CONFIG,
	DEFAULT_LOYALTY_TIERS_CONFIG,
	DEFAULT_LOYALTY_WELCOME_BONUS_CONFIG,
	LOYALTY_MAX_CATEGORY_IDS,
	LOYALTY_MAX_ITEM_IDS,
	LOYALTY_MAX_RULE_POINTS,
	LOYALTY_MAX_SPEND_PER_MINOR,
	LOYALTY_MULTIPLIER_ONE_BP,
	loyaltyProgramConfigSchema,
	type LoyaltyEarningMethod,
	type LoyaltyEarningRule,
	type LoyaltyFeatures,
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
	bpToPercentInput,
	isUsableTimeZone,
	minorToMoneyInput,
	parsePercentToBp,
} from '#app/utils/loyalty/loyalty-view.ts'
import {
	currencyExponent,
	minorToMajor,
	parseMoneyToMinor,
	parseWholeNumber,
} from '#app/utils/money-input.ts'
import { CatalogPicker } from './catalog-picker.tsx'
import {
	ExpiryCard,
	ReferralsCard,
	TiersCard,
	validateProgramExtensions,
	WelcomeBonusCard,
	type ProgramExtensionErrors,
	type ProgramExtensionState,
} from './program-extension-cards.tsx'

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

function extensionDefaults(
	program: LoyaltyOperatorProgram | null,
): ProgramExtensionState {
	const config = program?.current.config
	const currency = config?.currency
	const welcome = config?.welcomeBonus ?? DEFAULT_LOYALTY_WELCOME_BONUS_CONFIG
	const tiers = config?.tiers ?? DEFAULT_LOYALTY_TIERS_CONFIG
	const expiry = config?.expiry ?? DEFAULT_LOYALTY_EXPIRY_CONFIG
	const ref = config?.referrals ?? DEFAULT_LOYALTY_REFERRAL_CONFIG
	return {
		welcomeEnabled: welcome.enabled,
		welcomePoints: welcome.points > 0 ? String(welcome.points) : '50',
		welcomeAfterFirstOrder: welcome.afterFirstPaidOrder,
		tiersEnabled: tiers.enabled,
		tierMetric: tiers.metric,
		tierPeriodMonths: String(tiers.periodMonths),
		tierGraceDays: String(tiers.graceDays),
		tierRows: tiers.tiers.map((tier) => ({
			id: tier.id,
			name: tier.name,
			threshold:
				tiers.metric === 'spend_minor'
					? minorToMoneyInput(tier.threshold, currency)
					: String(tier.threshold),
			multiplier: String(tier.multiplierBp / LOYALTY_MULTIPLIER_ONE_BP),
		})),
		expiryMode: expiry.mode,
		expiryMonths: String(expiry.months),
		refEnabled: ref.enabled,
		refReferrerPoints: String(ref.referrerPoints),
		refFriendPoints: String(ref.friendPoints),
		refDiscountType: ref.friendDiscount ? ref.friendDiscount.type : 'none',
		refDiscountAmount:
			ref.friendDiscount?.type === 'fixed'
				? minorToMoneyInput(ref.friendDiscount.amountMinor, currency)
				: '',
		refDiscountPercent:
			ref.friendDiscount?.type === 'percent'
				? bpToPercentInput(ref.friendDiscount.percentBp)
				: '',
		refDiscountMax:
			ref.friendDiscount?.type === 'percent'
				? minorToMoneyInput(ref.friendDiscount.maxDiscountMinor, currency)
				: '',
		refMinOrder:
			ref.minimumOrderMinor > 0
				? minorToMoneyInput(ref.minimumOrderMinor, currency)
				: '',
		refHoldDays: String(ref.holdDays),
		refMaxPerMember: String(ref.maxReferralsPerMember),
		refMaxPerMonth:
			ref.maxReferralsPerMonth !== null ? String(ref.maxReferralsPerMonth) : '',
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
	features = { enabled: true, redemption: true, referrals: false },
	locationAddresses = [],
	canManage,
	saving,
	onSave,
	onDirtyChange,
}: {
	program: LoyaltyOperatorProgram | null
	catalog: LoyaltyCatalog
	defaultTimeZone: string
	features?: LoyaltyFeatures
	locationAddresses?: readonly string[]
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
	const defaultExt = useMemo(() => extensionDefaults(program), [program])
	const [ext, setExt] = useState<ProgramExtensionState>(defaultExt)
	const [extErrors, setExtErrors] = useState<ProgramExtensionErrors>({})
	const [liveCurrency, setLiveCurrency] = useState(defaults.currency)
	const [liveTimeZone, setLiveTimeZone] = useState(defaults.timeZone)
	const updateExt = useCallback((patch: Partial<ProgramExtensionState>) => {
		setExt((prev) => ({ ...prev, ...patch }))
		setExtErrors({})
	}, [])
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
			const extErrs = validateProgramExtensions(
				ext,
				value.currency,
				value.timeZone,
				locationAddresses,
				tx,
				(text, bounds) =>
					parseMoneyToMinor(text, { ...bounds, currency: value.currency }),
				(text, bounds) => parseWholeNumber(text, bounds),
			)
			if (Object.keys(extErrs).length > 0) {
				setExtErrors(extErrs)
				return
			}
			const existingConfig = program?.current.config
			const welcomeBonus = ext.welcomeEnabled
				? {
						enabled: true,
						points: parseWholeNumber(ext.welcomePoints, { min: 1 })!,
						afterFirstPaidOrder: ext.welcomeAfterFirstOrder,
					}
				: DEFAULT_LOYALTY_WELCOME_BONUS_CONFIG
			const tiers = ext.tiersEnabled
				? {
						enabled: true,
						metric: ext.tierMetric,
						periodMonths: parseWholeNumber(ext.tierPeriodMonths, { min: 1 })!,
						graceDays: parseWholeNumber(ext.tierGraceDays, { min: 0 })!,
						tiers: ext.tierRows.map((row) => ({
							id: row.id,
							name: row.name.trim(),
							threshold:
								ext.tierMetric === 'spend_minor'
									? parseMoneyToMinor(row.threshold, {
											min: 1,
											currency: value.currency,
										})!
									: parseWholeNumber(row.threshold, { min: 1 })!,
							multiplierBp: Math.round(
								Number(row.multiplier) * LOYALTY_MULTIPLIER_ONE_BP,
							),
						})),
					}
				: DEFAULT_LOYALTY_TIERS_CONFIG
			const expiry =
				ext.expiryMode === 'never'
					? DEFAULT_LOYALTY_EXPIRY_CONFIG
					: {
							mode: ext.expiryMode,
							months: parseWholeNumber(ext.expiryMonths, { min: 1 })!,
							enabledAt: existingConfig?.expiry.enabledAt ?? null,
						}
			const referrals = features.referrals
				? ext.refEnabled
					? {
							enabled: true,
							referrerPoints: parseWholeNumber(ext.refReferrerPoints, {
								min: 0,
							})!,
							friendPoints: parseWholeNumber(ext.refFriendPoints, { min: 0 })!,
							friendDiscount:
								ext.refDiscountType === 'fixed'
									? {
											type: 'fixed' as const,
											amountMinor: parseMoneyToMinor(ext.refDiscountAmount, {
												min: 1,
												currency: value.currency,
											})!,
										}
									: ext.refDiscountType === 'percent'
										? {
												type: 'percent' as const,
												percentBp: parsePercentToBp(ext.refDiscountPercent)!,
												maxDiscountMinor: parseMoneyToMinor(
													ext.refDiscountMax,
													{ min: 1, currency: value.currency },
												),
											}
										: null,
							minimumOrderMinor:
								parseMoneyToMinor(ext.refMinOrder, {
									min: 0,
									currency: value.currency,
								}) ?? 0,
							holdDays: parseWholeNumber(ext.refHoldDays, { min: 0 })!,
							maxReferralsPerMember: parseWholeNumber(ext.refMaxPerMember, {
								min: 1,
							})!,
							maxReferralsPerMonth:
								ext.refMaxPerMonth.trim() !== ''
									? parseWholeNumber(ext.refMaxPerMonth, { min: 1 })!
									: null,
						}
					: DEFAULT_LOYALTY_REFERRAL_CONFIG
				: (existingConfig?.referrals ?? DEFAULT_LOYALTY_REFERRAL_CONFIG)

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
				// Promotions are edited on their own page; saving the program keeps
				// them (and how they stack) exactly as they are.
				promotions: program?.current.config.promotions ?? [],
				promotionStacking: program?.current.config.promotionStacking ?? 'best',
				welcomeBonus,
				tiers,
				expiry,
				referrals,
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
	const extDirty = useMemo(
		() => JSON.stringify(ext) !== JSON.stringify(defaultExt),
		[ext, defaultExt],
	)
	const dirty =
		form.dirty ||
		extDirty ||
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
						onChange={(event) =>
							setLiveCurrency(event.target.value.trim().toUpperCase())
						}
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
						onChange={(event) => setLiveTimeZone(event.target.value.trim())}
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

			<WelcomeBonusCard
				state={ext}
				onChange={updateExt}
				errors={extErrors}
				unitLabelText={unitLabelText}
				readOnly={readOnly}
			/>

			<TiersCard
				state={ext}
				onChange={updateExt}
				errors={extErrors}
				readOnly={readOnly}
				unitLabelText={unitLabelText}
				currency={liveCurrency || defaults.currency}
			/>

			<ExpiryCard
				state={ext}
				onChange={updateExt}
				errors={extErrors}
				readOnly={readOnly}
				unitLabelText={unitLabelText}
				currency={liveCurrency || defaults.currency}
				timeZone={liveTimeZone || defaults.timeZone}
				locationAddresses={locationAddresses}
			/>

			{features.referrals ? (
				<ReferralsCard
					state={ext}
					onChange={updateExt}
					errors={extErrors}
					readOnly={readOnly}
					unitLabelText={unitLabelText}
					currency={liveCurrency || defaults.currency}
				/>
			) : null}

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
