import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { useGiftCards } from '../../lib/app/use-app'
import {
	type GiftCardsSnapshot,
	type GiftCardsStore,
} from '../../lib/gift-cards/gift-cards-store'
import { giftCardErrorText } from '../../lib/gift-cards/labels'
import { useNow } from '../../lib/support/use-now'
import { Button, EmptyState, LoadingView, Screen, Text } from '../ui'
import { ClaimCard } from './claim-card'
import { GiftCardItem } from './gift-card-item'
import { useGiftCardText } from './use-gift-card-text'

/**
 * The gift card wallet: the cards saved to the account, adding one by its
 * code, and the code the till scans. Buying a card happens on the website.
 * Leaving the screen hides any till code, so one is never left showing.
 */
export function GiftCardsScreen({ focused = true }: { focused?: boolean }) {
	const giftCards = useGiftCards()
	const { label } = useGiftCardText()
	const store = giftCards?.store ?? null
	useEffect(() => {
		store?.start()
	}, [store])
	const wasFocused = useRef(focused)
	useEffect(() => {
		if (!store) return
		if (!focused) store.hideToken()
		// Coming back to the tab refreshes the balances behind what is shown.
		else if (!wasFocused.current) void store.refresh()
		wasFocused.current = focused
	}, [focused, store])
	if (!giftCards) return <LoadingView label={label('loading')} />
	return (
		<Wallet
			store={giftCards.store}
			snapshot={giftCards.snapshot}
			focused={focused}
		/>
	)
}

function Wallet({
	store,
	snapshot,
	focused,
}: {
	store: GiftCardsStore
	snapshot: GiftCardsSnapshot
	focused: boolean
}) {
	const { i18n, label } = useGiftCardText()
	const [pulling, setPulling] = useState(false)
	const now = useNow(focused && snapshot.token.deadlineMs !== null)
	const onRefresh = () => {
		setPulling(true)
		void store.refresh().finally(() => setPulling(false))
	}

	if (snapshot.availability === 'unavailable') {
		return (
			<Screen scroll onRefresh={onRefresh} refreshing={pulling}>
				<View className="py-5">
					<EmptyState
						title={label('unavailableTitle')}
						body={label('unavailableBody')}
					/>
				</View>
			</Screen>
		)
	}
	switch (snapshot.status) {
		case 'idle':
		case 'loading':
			return <LoadingView label={label('loading')} />
		case 'failed':
			return (
				<Screen>
					<View className="flex-1 items-start justify-center gap-3">
						<Text variant="error" accessibilityLiveRegion="polite">
							{giftCardErrorText(i18n, snapshot.error?.code ?? 'unknown')}
						</Text>
						<Button variant="outline" onPress={() => void store.refresh()}>
							{label('retry')}
						</Button>
					</View>
				</Screen>
			)
		case 'signedOut':
			// The app signs out too and its gate shows sign-in; this is the moment between.
			return (
				<Screen scroll>
					<View className="py-5">
						<EmptyState
							title={label('signedOutTitle')}
							body={label('signedOutBody')}
						/>
					</View>
				</Screen>
			)
		case 'ready':
			return (
				<Screen scroll onRefresh={onRefresh} refreshing={pulling}>
					<View className="gap-4 py-5">
						{snapshot.error ? (
							<Text variant="error" accessibilityLiveRegion="polite">
								{giftCardErrorText(i18n, snapshot.error.code)}
							</Text>
						) : null}
						{snapshot.cards.length === 0 ? (
							<EmptyState
								title={label('emptyTitle')}
								body={label('emptyBody')}
							/>
						) : (
							snapshot.cards.map((card) => (
								<GiftCardItem
									key={card.id}
									card={card}
									token={snapshot.token}
									now={now}
									onShow={() => void store.showAtTill(card.id)}
									onHide={() => store.hideToken()}
								/>
							))
						)}
						<ClaimCard
							state={snapshot.claim}
							onClaim={(code) => store.claim(code)}
							onDismiss={() => store.dismissClaim()}
						/>
					</View>
				</Screen>
			)
	}
}
