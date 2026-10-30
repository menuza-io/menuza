import { getFormProps, useForm, useInputControl } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	LOYALTY_MAX_CATEGORY_IDS,
	LOYALTY_MAX_ITEM_IDS,
	LOYALTY_MAX_REWARD_COST,
	loyaltyRewardDefinitionSchema,
	type LoyaltyCatalogLabels,
	type LoyaltyDiscount,
	type LoyaltyOperatorReward,
	type LoyaltyRewardDefinition,
	type LoyaltyRewardKind,
} from '@repo/loyalty'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { ErrorList } from '#app/components/forms.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	catalogLabelsFor,
	joinCatalogIds,
	splitCatalogIds,
	type LoyaltyCatalog,
} from '#app/utils/loyalty/catalog.ts'
import {
	afterFailedLoyaltySubmit,
	loyaltyKeyForSubmit,
	newLoyaltySubmitKey,
	type LoyaltyClient,
} from '#app/utils/loyalty/loyalty-client.ts'
import { loyaltyErrorMessage } from '#app/utils/loyalty/loyalty-errors.ts'
import {
	bpToPercentInput,
	minorToMoneyInput,
	parsePercentToBp,
} from '#app/utils/loyalty/loyalty-view.ts'
import { parseMoneyToMinor, parseWholeNumber } from '#app/utils/money-input.ts'
import { CatalogPicker } from './catalog-picker.tsx'

type RewardFormValues = {
	name: string
	description: string
	pointsCost: string
	kind: LoyaltyRewardKind
	discountType: 'fixed' | 'percent'
	amount: string
	percent: string
	maxDiscount: string
	itemIds: string
	categoryIds: string
	freeItemId: string
}

function rewardDefaults(
	reward: LoyaltyOperatorReward | null,
	currency: string | null,
): RewardFormValues {
	const definition = reward?.definition
	const discount =
		definition && 'discount' in definition ? definition.discount : null
	return {
		name: definition?.name ?? '',
		description: definition?.description ?? '',
		pointsCost: definition ? String(definition.pointsCost) : '',
		kind: definition?.kind ?? 'order',
		discountType: discount?.type === 'percent' ? 'percent' : 'fixed',
		amount:
			discount?.type === 'fixed'
				? minorToMoneyInput(discount.amountMinor, currency)
				: '',
		percent:
			discount?.type === 'percent' ? bpToPercentInput(discount.percentBp) : '',
		maxDiscount:
			discount?.type === 'percent'
				? minorToMoneyInput(discount.maxDiscountMinor, currency)
				: '',
		itemIds:
			definition?.kind === 'items' ? joinCatalogIds(definition.itemIds) : '',
		categoryIds:
			definition?.kind === 'categories'
				? joinCatalogIds(definition.categoryIds)
				: '',
		freeItemId: definition?.kind === 'free_item' ? definition.itemId : '',
	}
}

/** Creates a reward, or saves an edit as the reward's next version. */
export function RewardDialog({
	client,
	reward,
	currency = null,
	catalog,
	onClose,
	onSaved,
}: {
	client: LoyaltyClient
	reward: LoyaltyOperatorReward | null
	/** The program currency, for a new reward; an edit uses the reward's. */
	currency?: string | null
	catalog: LoyaltyCatalog
	onClose: () => void
	onSaved: (reward: LoyaltyOperatorReward) => void
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
				className="sm:max-w-lg"
				data-testid="loyalty-reward-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						{reward ? <Trans>Edit reward</Trans> : <Trans>New reward</Trans>}
					</DialogTitle>
					<DialogDescription>
						<Trans>What the customer gets, and how many points it costs.</Trans>
					</DialogDescription>
				</DialogHeader>
				{/* The form mounts with the dialog content, so its controls find it. */}
				<RewardForm
					client={client}
					reward={reward}
					currency={reward?.currency ?? currency}
					catalog={catalog}
					submitting={submitting}
					onSubmittingChange={setSubmitting}
					onClose={onClose}
					onSaved={onSaved}
				/>
			</DialogContent>
		</Dialog>
	)
}

function RewardForm({
	client,
	reward,
	currency,
	catalog,
	submitting,
	onSubmittingChange: setSubmitting,
	onClose,
	onSaved,
}: {
	client: LoyaltyClient
	reward: LoyaltyOperatorReward | null
	currency: string | null
	catalog: LoyaltyCatalog
	submitting: boolean
	onSubmittingChange: (submitting: boolean) => void
	onClose: () => void
	onSaved: (reward: LoyaltyOperatorReward) => void
}) {
	const { t, i18n } = useLingui()
	const defaults = useMemo(
		() => rewardDefaults(reward, currency),
		[reward, currency],
	)
	const [kind, setKind] = useState<LoyaltyRewardKind>(defaults.kind)
	const [discountType, setDiscountType] = useState<'fixed' | 'percent'>(
		defaults.discountType,
	)
	const [error, setError] = useState<string | null>(null)
	const keyRef = useRef(newLoyaltySubmitKey('reward'))
	const savedLabels: LoyaltyCatalogLabels = reward?.definition.labels ?? {
		items: {},
		categories: {},
	}

	// Conform turns an empty or missing field into undefined, so every text
	// field defaults to '' and keeps its own message instead of "Required".
	const schema = useMemo(
		() =>
			z
				.object({
					name: z
						.string()
						.trim()
						.min(1, t`Enter a reward name.`)
						.max(80, t`Keep the name under 80 characters.`)
						.default(''),
					description: z
						.string()
						.trim()
						.max(280, t`Keep the description under 280 characters.`)
						.default(''),
					pointsCost: z
						.string()
						.trim()
						.refine(
							(value) =>
								parseWholeNumber(value, {
									min: 1,
									max: LOYALTY_MAX_REWARD_COST,
								}) !== null,
							t`Enter a whole number of points, at least 1.`,
						)
						.default(''),
					kind: z.enum(['order', 'categories', 'items', 'free_item']),
					discountType: z.enum(['fixed', 'percent']),
					amount: z.string().trim().default(''),
					percent: z.string().trim().default(''),
					maxDiscount: z.string().trim().default(''),
					itemIds: z.string().default(''),
					categoryIds: z.string().default(''),
					freeItemId: z.string().trim().default(''),
				})
				.superRefine((value, ctx) => {
					const needsDiscount = value.kind !== 'free_item'
					if (needsDiscount && value.discountType === 'fixed') {
						if (
							parseMoneyToMinor(value.amount, { min: 1, currency }) === null
						) {
							ctx.addIssue({
								code: z.ZodIssueCode.custom,
								path: ['amount'],
								message: t`Enter the discount amount, like 5.00.`,
							})
						}
					}
					if (needsDiscount && value.discountType === 'percent') {
						if (parsePercentToBp(value.percent) === null) {
							ctx.addIssue({
								code: z.ZodIssueCode.custom,
								path: ['percent'],
								message: t`Enter a percentage between 1 and 100.`,
							})
						}
						if (
							value.maxDiscount !== '' &&
							parseMoneyToMinor(value.maxDiscount, { min: 1, currency }) ===
								null
						) {
							ctx.addIssue({
								code: z.ZodIssueCode.custom,
								path: ['maxDiscount'],
								message: t`Enter the cap, like 20.00, or leave it empty.`,
							})
						}
					}
					if (
						value.kind === 'items' &&
						splitCatalogIds(value.itemIds).length === 0
					) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							path: ['itemIds'],
							message: t`Choose at least one item.`,
						})
					}
					if (
						value.kind === 'categories' &&
						splitCatalogIds(value.categoryIds).length === 0
					) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							path: ['categoryIds'],
							message: t`Choose at least one category.`,
						})
					}
					if (value.kind === 'free_item' && value.freeItemId === '') {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							path: ['freeItemId'],
							message: t`Choose the free item.`,
						})
					}
				}),
		[t, currency],
	)

	const [form, fields] = useForm({
		id: 'loyalty-reward-form',
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
			const base = {
				name: value.name,
				description: value.description === '' ? null : value.description,
				pointsCost: parseWholeNumber(value.pointsCost)!,
			}
			const discount: LoyaltyDiscount =
				value.discountType === 'fixed'
					? {
							type: 'fixed',
							amountMinor: parseMoneyToMinor(value.amount, {
								min: 1,
								currency,
							})!,
						}
					: {
							type: 'percent',
							percentBp: parsePercentToBp(value.percent)!,
							maxDiscountMinor: parseMoneyToMinor(value.maxDiscount, {
								min: 1,
								currency,
							}),
						}
			const itemIds = splitCatalogIds(value.itemIds)
			const categoryIds = splitCatalogIds(value.categoryIds)
			const itemLabels = (ids: readonly string[]) => ({
				items: catalogLabelsFor(ids, catalog.items, savedLabels.items),
				categories: {},
			})
			const definition: LoyaltyRewardDefinition =
				value.kind === 'order'
					? {
							kind: 'order',
							...base,
							labels: { items: {}, categories: {} },
							discount,
						}
					: value.kind === 'categories'
						? {
								kind: 'categories',
								...base,
								labels: {
									items: {},
									categories: catalogLabelsFor(
										categoryIds,
										catalog.categories,
										savedLabels.categories,
									),
								},
								discount,
								categoryIds,
							}
						: value.kind === 'items'
							? {
									kind: 'items',
									...base,
									labels: itemLabels(itemIds),
									discount,
									itemIds,
								}
							: {
									kind: 'free_item',
									...base,
									labels: itemLabels([value.freeItemId]),
									itemId: value.freeItemId,
								}
			const checked = loyaltyRewardDefinitionSchema.safeParse(definition)
			if (!checked.success) {
				setError(t`Check the fields and try again.`)
				return
			}
			setSubmitting(true)
			setError(null)
			const payload = checked.data
			const request = reward
				? client.updateReward(
						reward.id,
						{ expectedVersion: reward.version, definition: payload },
						loyaltyKeyForSubmit(keyRef, 'reward', {
							rewardId: reward.id,
							expectedVersion: reward.version,
							definition: payload,
						}),
					)
				: client.createReward(
						payload,
						loyaltyKeyForSubmit(keyRef, 'reward', { definition: payload }),
					)
			request
				.then((saved) => {
					onSaved(saved)
				})
				.catch((err: unknown) => {
					afterFailedLoyaltySubmit(keyRef, 'reward', err)
					setError(
						loyaltyErrorMessage(
							err,
							(d) => i18n._(d),
							msg`The reward could not be saved.`,
						),
					)
				})
				.finally(() => {
					setSubmitting(false)
				})
		},
	})

	const itemsControl = useInputControl(fields.itemIds)
	const categoriesControl = useInputControl(fields.categoryIds)
	const freeItemControl = useInputControl(fields.freeItemId)
	const usesDiscount = kind !== 'free_item'

	return (
		<form
			{...getFormProps(form)}
			className="flex flex-col gap-4"
			data-testid="loyalty-reward-form"
		>
			<input type="hidden" name={fields.kind.name} value={kind} />
			<input
				type="hidden"
				name={fields.discountType.name}
				value={discountType}
			/>

			{error ? (
				<Alert variant="destructive" data-testid="loyalty-reward-error">
					<Icon name="alert-triangle" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			<TextField
				label={<Trans>Name</Trans>}
				id="loyalty-reward-name"
				name={fields.name.name}
				defaultValue={defaults.name}
				error={fields.name.errors?.[0] ?? null}
				maxLength={80}
				data-testid="loyalty-reward-name"
			/>
			<TextField
				label={<Trans>Description</Trans>}
				optional
				id="loyalty-reward-description"
				name={fields.description.name}
				defaultValue={defaults.description}
				error={fields.description.errors?.[0] ?? null}
				maxLength={280}
				data-testid="loyalty-reward-description"
			/>
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<TextField
					label={<Trans>Cost in points</Trans>}
					id="loyalty-reward-cost"
					name={fields.pointsCost.name}
					defaultValue={defaults.pointsCost}
					error={fields.pointsCost.errors?.[0] ?? null}
					inputMode="numeric"
					data-testid="loyalty-reward-cost"
				/>
				<SelectField
					label={<Trans>Reward type</Trans>}
					id="loyalty-reward-kind"
					testId="loyalty-reward-kind"
					options={[
						{ value: 'order', label: t`Whole order discount` },
						{ value: 'categories', label: t`Category discount` },
						{ value: 'items', label: t`Item discount` },
						{ value: 'free_item', label: t`Free item` },
					]}
					value={kind}
					onValueChange={(next) => setKind(next as LoyaltyRewardKind)}
					error={fields.kind.errors?.[0] ?? null}
				/>
			</div>

			{usesDiscount ? (
				<>
					<SelectField
						label={<Trans>Discount</Trans>}
						id="loyalty-reward-discount-type"
						testId="loyalty-reward-discount-type"
						options={[
							{ value: 'fixed', label: t`Fixed amount off` },
							{ value: 'percent', label: t`Percentage off` },
						]}
						value={discountType}
						onValueChange={(next) =>
							setDiscountType(next as 'fixed' | 'percent')
						}
						error={fields.discountType.errors?.[0] ?? null}
					/>
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						{discountType === 'fixed' ? (
							<TextField
								label={<Trans>Amount off</Trans>}
								hint={t`For example 5.00.`}
								id="loyalty-reward-amount"
								name={fields.amount.name}
								defaultValue={defaults.amount}
								error={fields.amount.errors?.[0] ?? null}
								inputMode="decimal"
								placeholder="5.00"
								data-testid="loyalty-reward-amount"
							/>
						) : (
							<>
								<TextField
									label={<Trans>Percent off</Trans>}
									hint={t`Between 1 and 100.`}
									id="loyalty-reward-percent"
									name={fields.percent.name}
									defaultValue={defaults.percent}
									error={fields.percent.errors?.[0] ?? null}
									inputMode="decimal"
									placeholder="10"
									data-testid="loyalty-reward-percent"
								/>
								<TextField
									label={<Trans>Maximum discount</Trans>}
									optional
									hint={t`Cap on the discount, for example 20.00.`}
									id="loyalty-reward-max-discount"
									name={fields.maxDiscount.name}
									defaultValue={defaults.maxDiscount}
									error={fields.maxDiscount.errors?.[0] ?? null}
									inputMode="decimal"
									placeholder="20.00"
									data-testid="loyalty-reward-max-discount"
								/>
							</>
						)}
					</div>
				</>
			) : null}

			{kind === 'items' ? (
				<CatalogPicker
					id="loyalty-reward-items"
					testId="loyalty-reward-items"
					label={<Trans>Discounted items</Trans>}
					hint={t`The discount applies to these items.`}
					multiple
					max={LOYALTY_MAX_ITEM_IDS}
					options={catalog.items}
					value={splitCatalogIds(itemsControl.value)}
					onChange={(ids) => itemsControl.change(joinCatalogIds(ids))}
					onClose={() => itemsControl.blur()}
					savedLabels={savedLabels.items}
					error={fields.itemIds.errors?.[0] ?? null}
					placeholder={t`Choose items`}
					emptyMessage={<Trans>The menu has no items yet.</Trans>}
				/>
			) : null}
			{kind === 'categories' ? (
				<CatalogPicker
					id="loyalty-reward-categories"
					testId="loyalty-reward-categories"
					label={<Trans>Discounted categories</Trans>}
					hint={t`The discount applies to items listed directly in these categories.`}
					multiple
					max={LOYALTY_MAX_CATEGORY_IDS}
					options={catalog.categories}
					value={splitCatalogIds(categoriesControl.value)}
					onChange={(ids) => categoriesControl.change(joinCatalogIds(ids))}
					onClose={() => categoriesControl.blur()}
					savedLabels={savedLabels.categories}
					error={fields.categoryIds.errors?.[0] ?? null}
					placeholder={t`Choose categories`}
					emptyMessage={<Trans>The menu has no categories yet.</Trans>}
				/>
			) : null}
			{kind === 'free_item' ? (
				<CatalogPicker
					id="loyalty-reward-free-item"
					testId="loyalty-reward-free-item"
					label={<Trans>Free item</Trans>}
					hint={t`One of this item, free. The customer picks the size or variant; paid extras are still charged.`}
					options={catalog.items}
					value={splitCatalogIds(freeItemControl.value)}
					onChange={(ids) => freeItemControl.change(ids[0] ?? '')}
					onClose={() => freeItemControl.blur()}
					savedLabels={savedLabels.items}
					error={fields.freeItemId.errors?.[0] ?? null}
					placeholder={t`Choose an item`}
					emptyMessage={<Trans>The menu has no items yet.</Trans>}
				/>
			) : null}

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
					data-testid="loyalty-reward-save"
				>
					{submitting ? (
						<Trans>Saving…</Trans>
					) : reward ? (
						<Trans>Save changes</Trans>
					) : (
						<Trans>Create reward</Trans>
					)}
				</Button>
			</DialogFooter>
		</form>
	)
}
