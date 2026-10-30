import { View } from 'react-native'
import {
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
