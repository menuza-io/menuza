import { Trans, useLingui } from '@lingui/react/macro'
import {
	estimateRewardReturn,
	LOYALTY_MULTIPLIER_ONE_BP,
	type LoyaltyDiscount,
	type LoyaltyEarningRule,
	type LoyaltyRewardKind,
	type LoyaltyTiersConfig,
} from '@repo/loyalty'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Icon } from '@repo/ui/icon'
import { useEffect, useState } from 'react'
import { TextField } from '#app/components/staff/controls.tsx'
import {
	formatBpPercent,
	formatLoyaltyMoney,
	minorToMoneyInput,
} from '#app/utils/loyalty/loyalty-view.ts'
import { parseMoneyToMinor } from '#app/utils/money-input.ts'

export type RewardReturnPreviewProps = {
	earning: LoyaltyEarningRule | null
	reward: {
		kind: LoyaltyRewardKind
		pointsCost: number | null
		discount?: LoyaltyDiscount | null
	}
	currency: string | null | undefined
	averageOrderMinor?: number | null
	itemPriceMinor?: number | null
	tiers?: LoyaltyTiersConfig | null
	onAverageOrderChange?: (minor: number | null) => void
	onItemPriceChange?: (minor: number | null) => void
	compact?: boolean
}

function highestMultiplierTier(tiers: LoyaltyTiersConfig | null | undefined) {
	if (!tiers?.enabled || tiers.tiers.length === 0) return null
	let best = null
	for (const tier of tiers.tiers) {
		if (
			tier.multiplierBp > LOYALTY_MULTIPLIER_ONE_BP &&
			(best === null || tier.multiplierBp > best.multiplierBp)
		) {
			best = tier
		}
	}
	return best
}

/**
 * Live estimate of how much effective percentage back a reward gives under
 * the active earning rule (and optional highest tier multiplier). (#414)
 */
export function RewardReturnPreview({
	earning,
	reward,
	currency,
	averageOrderMinor = null,
	itemPriceMinor = null,
	tiers = null,
	onAverageOrderChange,
	onItemPriceChange,
	compact = false,
}: RewardReturnPreviewProps) {
	const { t, i18n } = useLingui()
	const resolvedCurrency = currency?.trim().toUpperCase() || 'USD'
	const [avgText, setAvgText] = useState(() =>
		minorToMoneyInput(averageOrderMinor, resolvedCurrency),
	)
	const [itemText, setItemText] = useState(() =>
		minorToMoneyInput(itemPriceMinor, resolvedCurrency),
	)
	useEffect(() => {
		setItemText((prev) => {
			const formatted = minorToMoneyInput(itemPriceMinor, resolvedCurrency)
			const parsedPrev = parseMoneyToMinor(prev, {
				min: 1,
				currency: resolvedCurrency,
			})
			return parsedPrev === itemPriceMinor ? prev : formatted
		})
	}, [itemPriceMinor, resolvedCurrency])

	if (!earning || !reward.pointsCost || reward.pointsCost < 1) {
		return null
	}
	if (reward.kind !== 'free_item' && !reward.discount) {
		return null
	}

	const result = estimateRewardReturn({
		earning,
		reward: {
			kind: reward.kind,
			pointsCost: reward.pointsCost,
			discount: reward.kind === 'free_item' ? null : reward.discount,
		},
		averageOrderMinor,
		itemPriceMinor,
	})

	const topTier = highestMultiplierTier(tiers)
	const topTierResult =
		topTier && result.status === 'ok'
			? estimateRewardReturn({
					earning,
					reward: {
						kind: reward.kind,
						pointsCost: reward.pointsCost,
						discount: reward.kind === 'free_item' ? null : reward.discount,
					},
					averageOrderMinor,
					itemPriceMinor,
					tierMultiplierBp: topTier.multiplierBp,
				})
			: null

	if (compact) {
		if (result.status !== 'ok') {
			return (
				<span
					className="text-muted-foreground text-xs"
					data-testid="loyalty-reward-return-needs-input"
				>
					<Trans>Set sample price to preview</Trans>
				</span>
			)
		}
		const pctText = formatBpPercent(result.effectiveReturnBp, i18n.locale)
		return (
			<div
				className="inline-flex items-center gap-1.5"
				data-testid="loyalty-reward-return-compact"
			>
				<span className="text-xs tabular-nums" dir="ltr">
					{pctText}
				</span>
				{result.exceedsWarning ? (
					<Badge variant="warning" className="text-[11px]">
						<Trans>High return</Trans>
					</Badge>
				) : null}
			</div>
		)
	}

	const needsSampleInput = result.status === 'needs_input'
	const usesAverageOrder =
		earning.method === 'visit' ||
		(reward.kind === 'order' && reward.discount?.type === 'percent')
	const usesItemPrice =
		reward.kind === 'free_item' ||
		((reward.kind === 'items' || reward.kind === 'categories') &&
			reward.discount?.type === 'percent') ||
		earning.method === 'items' ||
		earning.method === 'categories'
	const pctText =
		result.status === 'ok'
			? formatBpPercent(result.effectiveReturnBp, i18n.locale)
			: null
	const spendText =
		result.status === 'ok'
			? formatLoyaltyMoney(
					result.spendToEarnMinor,
					resolvedCurrency,
					i18n.locale,
				)
			: null
	const valueText =
		result.status === 'ok'
			? formatLoyaltyMoney(
					result.rewardValueMinor,
					resolvedCurrency,
					i18n.locale,
				)
			: null
	const costPoints = reward.pointsCost

	return (
		<div
			className="bg-muted/40 flex flex-col gap-2 rounded-lg border p-3 text-sm"
			data-testid="loyalty-reward-return-preview"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="font-medium">
					<Trans>Effective return preview</Trans>
				</span>
				{pctText ? (
					<Badge
						variant={
							result.status === 'ok' && result.exceedsWarning
								? 'warning'
								: 'secondary'
						}
						data-testid="loyalty-reward-return-badge"
					>
						<span dir="ltr" className="tabular-nums">
							{pctText}
						</span>{' '}
						<Trans>back</Trans>
					</Badge>
				) : null}
			</div>

			{result.status === 'ok' && spendText && valueText && pctText ? (
				<p
					className="text-muted-foreground text-xs"
					data-testid="loyalty-reward-return-summary"
				>
					<Trans>
						Spend <bdi dir="ltr">{spendText}</bdi> to earn{' '}
						<bdi dir="ltr" className="tabular-nums">
							{costPoints}
						</bdi>{' '}
						points, then get <bdi dir="ltr">{valueText}</bdi> off ({pctText}{' '}
						back).
					</Trans>
				</p>
			) : null}

			{topTier &&
			topTierResult?.status === 'ok' &&
			topTierResult.effectiveReturnBp !==
				(result.status === 'ok' ? result.effectiveReturnBp : 0)
				? (() => {
						const topTierName = topTier.name
						const topTierMult = (
							topTier.multiplierBp / LOYALTY_MULTIPLIER_ONE_BP
						)
							.toFixed(2)
							.replace(/\.00$/, '')
						const topTierPct = formatBpPercent(
							topTierResult.effectiveReturnBp,
							i18n.locale,
						)
						return (
							<p
								className="text-muted-foreground text-xs"
								data-testid="loyalty-reward-return-tier"
							>
								<Trans>
									At tier <span className="font-medium">{topTierName}</span> (
									<bdi dir="ltr" className="tabular-nums">
										{topTierMult}×
									</bdi>
									):{' '}
									<bdi dir="ltr" className="tabular-nums">
										{topTierPct}
									</bdi>{' '}
									back.
								</Trans>
							</p>
						)
					})()
				: null}

			{usesAverageOrder ||
			(needsSampleInput && result.missing === 'average_order') ? (
				onAverageOrderChange ? (
					<TextField
						label={<Trans>Sample order total</Trans>}
						optional
						hint={t`Enter a typical check size to preview the percentage back.`}
						id="loyalty-preview-average-order"
						value={avgText}
						onChange={(event) => {
							const raw = event.target.value
							setAvgText(raw)
							const minor = parseMoneyToMinor(raw, {
								min: 1,
								currency: resolvedCurrency,
							})
							onAverageOrderChange(minor)
						}}
						inputMode="decimal"
						placeholder="25.00"
						data-testid="loyalty-preview-average-order"
					/>
				) : needsSampleInput ? (
					<p className="text-muted-foreground text-xs">
						<Trans>Enter a sample order total to calculate return.</Trans>
					</p>
				) : null
			) : null}

			{usesItemPrice ||
			(needsSampleInput && result.missing === 'item_price') ? (
				onItemPriceChange ? (
					<TextField
						label={<Trans>Sample item price</Trans>}
						optional
						hint={t`Used to value a free or discounted item when calculating percent back.`}
						id="loyalty-preview-item-price"
						value={itemText}
						onChange={(event) => {
							const raw = event.target.value
							setItemText(raw)
							const minor = parseMoneyToMinor(raw, {
								min: 1,
								currency: resolvedCurrency,
							})
							onItemPriceChange(minor)
						}}
						inputMode="decimal"
						placeholder="5.00"
						data-testid="loyalty-preview-item-price"
					/>
				) : needsSampleInput ? (
					<p className="text-muted-foreground text-xs">
						<Trans>Enter an item price to calculate return.</Trans>
					</p>
				) : null
			) : null}

			{result.status === 'ok' && result.exceedsWarning ? (
				<Alert data-testid="loyalty-reward-return-warning">
					<Icon name="alert-triangle" />
					<AlertDescription>
						<Trans>
							Effective return exceeds 20%. Double-check the point cost or
							discount amount so you do not give away too much margin.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}
		</div>
	)
}
