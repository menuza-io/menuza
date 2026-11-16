import { View } from 'react-native'
import {
	type GiftCardsError,
	type GiftCardsTokenState,
} from '../../lib/gift-cards/gift-cards-store'
import { giftCardErrorText } from '../../lib/gift-cards/labels'
import { formatCountdown, isolateLtr } from '../../lib/loyalty/format'
import { Button, Text } from '../ui'
import { QrCode } from './qr-code'
import { useGiftCardText } from './use-gift-card-text'

/**
 * What staff scan to take payment from the card: a one-use token that stops
 * working in minutes, never the card code. Only the card it was issued for
 * shows it.
 */
export function TillCode({
	last4,
	token,
	now,
	onShow,
	onHide,
}: {
	last4: string
	token: GiftCardsTokenState
	now: number
	onShow: () => void
	onHide: () => void
}) {
	const { i18n, label } = useGiftCardText()
	const issuing = token.status === 'issuing'
	const live =
		token.token !== null && token.deadlineMs !== null && !token.expired
	const error: GiftCardsError | null = token.error
	return (
		<View className="gap-3">
			<Text variant="label">{label('tillHeading')}</Text>
			{live ? (
				<View className="border-border items-center gap-2 rounded-lg border p-3">
					<QrCode
						value={token.token ?? ''}
						accessibilityLabel={label('tillQrLabel', { last4 })}
					/>
				</View>
			) : (
				<Text variant="muted">{label('tillBody')}</Text>
			)}
			{live && token.deadlineMs !== null ? (
				<Text variant="muted" accessibilityLiveRegion="polite">
					{label('tillExpiresIn', {
						time: isolateLtr(formatCountdown(token.deadlineMs - now)),
					})}
				</Text>
			) : null}
			{token.expired ? (
				<Text variant="muted" accessibilityLiveRegion="polite">
					{label('tillExpired')}
				</Text>
			) : null}
			<Button
				variant={live ? 'outline' : 'primary'}
				loading={issuing}
				onPress={onShow}
			>
				{issuing
					? label('tillLoading')
					: label(live || token.expired ? 'tillRefresh' : 'tillShow')}
			</Button>
			{live ? (
				<Button variant="ghost" size="sm" onPress={onHide}>
					{label('tillHide')}
				</Button>
			) : null}
			{error ? (
				<Text variant="error" accessibilityLiveRegion="polite">
					{giftCardErrorText(i18n, error.code)}
				</Text>
			) : null}
			<Text variant="caption">{label('tillNotTheCode')}</Text>
		</View>
	)
}
