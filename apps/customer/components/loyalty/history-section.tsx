import { type LoyaltyPublicUnitLabel } from '@repo/loyalty'
import { View } from 'react-native'
import {
	channelLabel,
	formatDelta,
	formatEntryDate,
	historyEntryLabel,
	isolateLtr,
} from '../../lib/loyalty/format'
import { loyaltyErrorText } from '../../lib/loyalty/labels'
import { type HistoryState } from '../../lib/loyalty/loyalty-store'
import { Button, Text } from '../ui'
import { Section } from './notice-line'
import { useLoyaltyText } from './use-loyalty-text'

export function HistorySection({
	state,
	unit,
	onRetry,
	onMore,
}: {
	state: HistoryState
	unit: LoyaltyPublicUnitLabel
	onRetry: () => void
	onMore: () => void
}) {
	const { i18n, label } = useLoyaltyText()
	return (
		<Section title={label('historyHeading')}>
			{state.status === 'loading' ? (
				<Text variant="muted">{label('historyLoadingMore')}</Text>
			) : null}
			{state.entries.map((entry) => {
				const meta = [
					channelLabel(entry.channel, i18n),
					formatEntryDate(entry.at, i18n.locale),
				]
					.filter(Boolean)
					.join(' · ')
				return (
					<View
						key={entry.id}
						className="border-border flex-row items-center justify-between gap-3 border-b py-2"
					>
						<View className="flex-1 gap-0.5">
							<Text>{historyEntryLabel(entry, i18n)}</Text>
							<Text variant="caption">{meta}</Text>
						</View>
						<Text variant="label">
							{isolateLtr(formatDelta(entry.delta, unit, i18n))}
						</Text>
					</View>
				)
			})}
			{state.status === 'ready' &&
			!state.error &&
			state.entries.length === 0 ? (
				<Text variant="muted">{label('historyEmpty')}</Text>
			) : null}
			{state.error ? (
				<View className="items-start gap-2">
					<Text variant="error" accessibilityLiveRegion="polite">
						{loyaltyErrorText(i18n, state.error.code)}
					</Text>
					<Button
						variant="outline"
						size="sm"
						onPress={state.status === 'error' ? onRetry : onMore}
					>
						{label('retry')}
					</Button>
				</View>
			) : null}
			{state.hasMore && !state.error ? (
				<Button variant="outline" loading={state.loadingMore} onPress={onMore}>
					{state.loadingMore
						? label('historyLoadingMore')
						: label('historyMore')}
				</Button>
			) : null}
		</Section>
	)
}
