import { View } from 'react-native'
import {
	formatCountdown,
	isolateLtr,
	spellCode,
} from '../../lib/loyalty/format'
import { loyaltyErrorText } from '../../lib/loyalty/labels'
import { type MemberCodeState } from '../../lib/loyalty/loyalty-store'
import { Button, Text } from '../ui'
import { Section } from './notice-line'
import { useLoyaltyText } from './use-loyalty-text'

/**
 * The code staff type at the till to find the customer's points. Plain text, read
 * one character at a time by screen readers; it only identifies, it never
 * spends.
 */
export function MemberCodeCard({
	state,
	now,
	onIssue,
}: {
	state: MemberCodeState
	now: number
	onIssue: () => void
}) {
	const { i18n, label } = useLoyaltyText()
	const issuing = state.status === 'issuing'
	const action = issuing
		? label('codeLoading')
		: label(state.code || state.expired ? 'codeRefresh' : 'codeShow')
	return (
		<Section title={label('codeHeading')}>
			<Text variant="muted">{label('codeBody')}</Text>
			{state.code ? (
				<View className="border-border bg-background items-center gap-1 rounded-lg border p-4">
					<View
						accessible
						accessibilityLabel={`${label('codeLabel')}: ${spellCode(state.code)}`}
						className="items-center gap-1"
					>
						<Text variant="muted">{label('codeLabel')}</Text>
						<Text variant="code" selectable>
							{state.code}
						</Text>
					</View>
					{state.deadlineMs !== null ? (
						<Text variant="muted">
							{label('codeExpiresIn', {
								time: isolateLtr(formatCountdown(state.deadlineMs - now)),
							})}
						</Text>
					) : null}
				</View>
			) : state.expired ? (
				<Text variant="muted" accessibilityLiveRegion="polite">
					{label('codeExpired')}
				</Text>
			) : null}
			<Button
				variant={state.code ? 'outline' : 'primary'}
				loading={issuing}
				onPress={onIssue}
			>
				{action}
			</Button>
			{state.error ? (
				<Text variant="error" accessibilityLiveRegion="polite">
					{loyaltyErrorText(i18n, state.error.code)}
				</Text>
			) : null}
			<Text variant="caption">{label('codeNotSpending')}</Text>
		</Section>
	)
}
