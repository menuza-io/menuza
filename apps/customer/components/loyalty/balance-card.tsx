import { View } from 'react-native'
import {
	formatEntryDate,
	formatMinor,
	formatPercent,
	formatPoints,
	isolateName,
} from '../../lib/loyalty/format'
import {
	type LoyaltyMemberWallet,
	type NextRewardView,
} from '../../lib/loyalty/wallet-view'
import { Card, ProgressBar, Text } from '../ui'
import { useLoyaltyText } from './use-loyalty-text'

export function BalanceCard({
	wallet,
	nextReward,
}: {
	wallet: LoyaltyMemberWallet
	nextReward: NextRewardView
}) {
	const { i18n, label } = useLoyaltyText()
	const unit = wallet.program.unitLabel
	const { balance } = wallet
	return (
		<Card className="gap-3">
			<Text variant="label" accessibilityRole="header">
				{label('balanceHeading')}
			</Text>
			<Text variant="display">
				{formatPoints(balance.available, unit, i18n)}
			</Text>
			{balance.reserved > 0 ? (
				<Text variant="muted">
					{label('reservedLabel', {
						amount: formatPoints(balance.reserved, unit, i18n),
					})}
				</Text>
			) : null}
			{balance.available < 0 ? (
				<Text variant="muted">{label('owedNotice')}</Text>
			) : null}
			{wallet.expiry &&
			wallet.expiry.nextExpiryPoints > 0 &&
			wallet.expiry.nextExpiryAt !== null ? (
				<Text variant="muted">
					{label('expiryWarning', {
						points: formatPoints(wallet.expiry.nextExpiryPoints, unit, i18n),
						date: formatEntryDate(
							wallet.expiry.nextExpiryAt,
							i18n.locale,
							'date',
						),
					})}
				</Text>
			) : null}
			{wallet.welcomeBonus && wallet.welcomeBonus.points > 0 ? (
				wallet.welcomeBonus.status === 'granted' ? (
					<Text>
						{label('welcomeGranted', {
							points: formatPoints(wallet.welcomeBonus.points, unit, i18n),
						})}
					</Text>
				) : wallet.welcomeBonus.status === 'pending_first_order' ? (
					<Text variant="muted">
						{label('welcomePending', {
							points: formatPoints(wallet.welcomeBonus.points, unit, i18n),
						})}
					</Text>
				) : null
			) : null}
			{wallet.tier ? (
				<View className="border-border bg-background gap-1 rounded-lg border p-3">
					{wallet.tier.current ? (
						<Text variant="label">
							{label('tierCurrent', {
								tier: isolateName(wallet.tier.current.name),
							})}
						</Text>
					) : null}
					{wallet.tier.current && wallet.tier.current.multiplierBp > 10_000 ? (
						<Text variant="caption">
							{label('tierMultiplier', {
								multiplier: (wallet.tier.current.multiplierBp / 10_000)
									.toFixed(2)
									.replace(/\.00$/, ''),
							})}
						</Text>
					) : null}
					{wallet.tier.next ? (
						<Text variant="caption">
							{label('tierNextProgress', {
								amount:
									wallet.tier.metric === 'spend_minor'
										? formatMinor(
												wallet.tier.next.pointsRemaining,
												wallet.program.currency,
												i18n.locale,
											)
										: formatPoints(
												wallet.tier.next.pointsRemaining,
												unit,
												i18n,
											),
								tier: isolateName(wallet.tier.next.name),
							})}
						</Text>
					) : wallet.tier.current ? (
						<Text variant="caption">{label('tierTopReached')}</Text>
					) : null}
					{wallet.tier.reviewAt ? (
						<Text variant="caption">
							{label('tierReviewDate', {
								date: formatEntryDate(
									wallet.tier.reviewAt,
									i18n.locale,
									'date',
								),
							})}
						</Text>
					) : null}
					{wallet.tier.graceUntil && wallet.tier.current ? (
						<Text variant="caption">
							{label('tierGraceWarning', {
								date: formatEntryDate(
									wallet.tier.graceUntil,
									i18n.locale,
									'date',
								),
								tier: isolateName(wallet.tier.current.name),
								nextTier: isolateName(
									wallet.tier.pendingDowngradeTierName ?? '',
								),
							})}
						</Text>
					) : null}
				</View>
			) : null}
			{nextReward?.kind === 'next' ? (
				<View className="gap-2">
					<Text>
						{label('nextRewardProgress', {
							amount: formatPoints(nextReward.pointsNeeded, unit, i18n),
							reward: isolateName(nextReward.reward.name),
						})}
					</Text>
					<ProgressBar
						percent={nextReward.percent}
						label={label('progressLabel', {
							reward: isolateName(nextReward.reward.name),
						})}
						valueText={formatPercent(nextReward.percent, i18n.locale)}
					/>
				</View>
			) : nextReward?.kind === 'all-unlocked' ? (
				<Text>{label('allRewardsUnlocked')}</Text>
			) : null}
		</Card>
	)
}
