import { Share, View } from 'react-native'
import { formatMinor, formatPoints } from '../../lib/loyalty/format'
import { type LoyaltyMemberWallet } from '../../lib/loyalty/wallet-view'
import { Button, Text } from '../ui'
import { Section } from './notice-line'
import { useLoyaltyText } from './use-loyalty-text'

export function ReferralCard({ wallet }: { wallet: LoyaltyMemberWallet }) {
	const { i18n, label } = useLoyaltyText()
	const ref = wallet.referral
	const progRef = wallet.program.referrals
	if (!ref || !progRef || !progRef.enabled) return null

	const unit = wallet.program.unitLabel
	const referrerPts = formatPoints(progRef.referrerPoints, unit, i18n)
	let friendPart = ''
	if (progRef.friendDiscount) {
		if (progRef.friendDiscount.type === 'fixed') {
			friendPart = formatMinor(
				progRef.friendDiscount.amountMinor,
				wallet.program.currency,
				i18n.locale,
			)
		} else {
			friendPart = `${(progRef.friendDiscount.percentBp / 100)
				.toFixed(0)
				.replace(/\.00$/, '')}%`
		}
	}
	if (progRef.friendPoints > 0) {
		const fPts = formatPoints(progRef.friendPoints, unit, i18n)
		friendPart = friendPart ? `${friendPart} + ${fPts}` : fPts
	}

	const summaryText = friendPart
		? label('referralSummaryPoints', {
				friendReward: friendPart,
				referrerPoints: referrerPts,
			})
		: label('referralSummaryNoFriend', {
				referrerPoints: referrerPts,
			})

	async function onShare() {
		if (!ref) return
		try {
			await Share.share({
				message: `${summaryText} ${ref.code}`,
			})
		} catch {
			// Share cancelled or unavailable
		}
	}

	return (
		<Section title={label('referralHeading')}>
			<Text>{summaryText}</Text>
			{progRef.minimumOrderMinor > 0 ? (
				<Text variant="caption">
					{label('referralMinOrder', {
						amount: formatMinor(
							progRef.minimumOrderMinor,
							wallet.program.currency,
							i18n.locale,
						),
					})}
				</Text>
			) : null}
			<View className="border-border bg-background flex-row items-center justify-between gap-3 rounded-lg border p-3">
				<View className="gap-0.5">
					<Text variant="caption">{label('referralCodeLabel')}</Text>
					<Text variant="label">{ref.code}</Text>
				</View>
				<Button variant="outline" onPress={() => void onShare()}>
					{label('referralCopyLink')}
				</Button>
			</View>
			<Text variant="caption">
				{label('referralStats', {
					credited: String(ref.creditedCount),
					pending: String(ref.pendingCount),
					points: formatPoints(ref.creditedPoints, unit, i18n),
				})}
			</Text>
			{ref.capReached ? (
				<Text variant="caption">{label('referralCapReached')}</Text>
			) : null}
		</Section>
	)
}
