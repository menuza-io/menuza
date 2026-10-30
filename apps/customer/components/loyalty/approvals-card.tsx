import { type LoyaltyPublicUnitLabel } from '@repo/loyalty'
import { View } from 'react-native'
import {
	approvalDetail,
	formatCountdown,
	isolateLtr,
	isolateName,
} from '../../lib/loyalty/format'
import { loyaltyErrorText } from '../../lib/loyalty/labels'
import { type ApprovalsState } from '../../lib/loyalty/loyalty-store'
import { Button, Text } from '../ui'
import { Section } from './notice-line'
import { useLoyaltyText } from './use-loyalty-text'

/** Till requests to spend points; nothing is spent until the member approves. */
export function ApprovalsCard({
	state,
	unit,
	now,
	onDecide,
	onCheck,
}: {
	state: ApprovalsState
	unit: LoyaltyPublicUnitLabel
	now: number
	onDecide: (id: string, decision: 'approve' | 'decline') => void
	onCheck: () => void
}) {
	const { i18n, label } = useLoyaltyText()
	return (
		<Section title={label('approvalsHeading')}>
			<Text variant="muted">{label('approvalsBody')}</Text>
			{state.items.map(({ approval, deadlineMs, deciding }) => {
				const reward = isolateName(approval.rewardName)
				return (
					<View
						key={approval.id}
						className="border-border bg-background gap-2 rounded-lg border p-3"
					>
						<Text variant="label">{label('approvalTitle', { reward })}</Text>
						<Text variant="muted">{approvalDetail(approval, unit, i18n)}</Text>
						{deadlineMs !== null ? (
							<Text variant="caption">
								{label('approvalExpiresIn', {
									time: isolateLtr(formatCountdown(deadlineMs - now)),
								})}
							</Text>
						) : null}
						<View className="flex-row gap-2">
							<View className="flex-1">
								<Button
									loading={deciding}
									accessibilityLabel={label('approveAria', { reward })}
									onPress={() => onDecide(approval.id, 'approve')}
								>
									{label('approve')}
								</Button>
							</View>
							<View className="flex-1">
								<Button
									variant="outline"
									disabled={deciding}
									accessibilityLabel={label('declineAria', { reward })}
									onPress={() => onDecide(approval.id, 'decline')}
								>
									{label('decline')}
								</Button>
							</View>
						</View>
					</View>
				)
			})}
			{state.status === 'ready' && state.items.length === 0 ? (
				<Text variant="muted">{label('approvalsEmpty')}</Text>
			) : null}
			{state.error ? (
				<Text variant="error" accessibilityLiveRegion="polite">
					{loyaltyErrorText(i18n, state.error.code)}
				</Text>
			) : null}
			<Button
				variant="outline"
				loading={state.checking || state.status === 'loading'}
				onPress={onCheck}
			>
				{label('approvalsCheck')}
			</Button>
		</Section>
	)
}
