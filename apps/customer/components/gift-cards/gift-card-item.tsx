import { View } from 'react-native'
import { formatGiftCardDate } from '../../lib/gift-cards/format'
import { type SavedGiftCardDto } from '../../lib/gift-cards/gift-cards-client'
import { type GiftCardsTokenState } from '../../lib/gift-cards/gift-cards-store'
import {
	giftCardActivityText,
	giftCardStatusText,
	giftCardUsable,
} from '../../lib/gift-cards/labels'
import { formatMinor, isolateLtr } from '../../lib/loyalty/format'
import { Badge, Card, Text } from '../ui'
import { TillCode } from './till-code'
import { useGiftCardText } from './use-gift-card-text'

/** No code for this card: what every other card shows while one card has a code up. */
const NO_TOKEN: GiftCardsTokenState = {
	status: 'idle',
	cardId: null,
	token: null,
	deadlineMs: null,
	expired: false,
	error: null,
}

/**
 * One saved card: its balance, its status when it is not simply usable, the
 * latest money movements, and (for a usable card) the code for the till.
 */
export function GiftCardItem({
	card,
	token,
	now,
	onShow,
	onHide,
}: {
	card: SavedGiftCardDto
	token: GiftCardsTokenState
	now: number
	onShow: () => void
	onHide: () => void
}) {
	const { i18n, label } = useGiftCardText()
	const status = giftCardStatusText(i18n, card.status)
	const usable = giftCardUsable(card.status)
	const balance = formatMinor(card.balanceMinor, card.currency, i18n.locale)
	const last4 = isolateLtr(card.last4)
	// Only the card a code was issued for shows it.
	const own = token.cardId === card.id ? token : NO_TOKEN
	// Money movements only: a history line with no money is not worth a row.
	const activity = card.recent.flatMap((entry) => {
		const text =
			entry.amountMinor === 0 ? null : giftCardActivityText(i18n, entry.kind)
		return text ? [{ entry, text }] : []
	})
	return (
		<Card className="gap-3">
			<View className="gap-1">
				<Text variant="label" accessibilityRole="header">
					{label('cardEndingIn', { last4 })}
				</Text>
				<View
					accessible
					accessibilityLabel={`${label('balanceLabel')}: ${balance}`}
				>
					<Text variant="heading">{balance}</Text>
				</View>
				{card.expiresAt !== null ? (
					<Text variant="caption">
						{label('expiresOn', {
							date: formatGiftCardDate(card.expiresAt, i18n.locale),
						})}
					</Text>
				) : null}
			</View>
			{status ? <Badge>{status}</Badge> : null}
			{card.note === 'being_prepared' ? (
				<Text variant="muted">{label('beingPrepared')}</Text>
			) : null}
			{!usable && status && card.note === null ? (
				<Text variant="muted">{label('statusNotUsable')}</Text>
			) : null}
			{usable ? (
				<TillCode
					last4={last4}
					token={own}
					now={now}
					onShow={onShow}
					onHide={onHide}
				/>
			) : null}
			{activity.length > 0 ? (
				<View className="gap-1">
					<Text variant="label">{label('recentHeading')}</Text>
					{activity.map(({ entry, text }) => (
						<View
							key={entry.id}
							className="flex-row items-center justify-between gap-3"
						>
							<View className="flex-1">
								<Text variant="body">{text}</Text>
								<Text variant="caption">
									{formatGiftCardDate(entry.at, i18n.locale)}
								</Text>
							</View>
							<Text variant="body">
								{isolateLtr(
									formatMinor(entry.amountMinor, card.currency, i18n.locale),
								)}
							</Text>
						</View>
					))}
				</View>
			) : null}
		</Card>
	)
}
