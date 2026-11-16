import { useState } from 'react'
import { View } from 'react-native'
import { type GiftCardsClaimState } from '../../lib/gift-cards/gift-cards-store'
import { giftCardErrorText } from '../../lib/gift-cards/labels'
import { isolateLtr } from '../../lib/loyalty/format'
import { Button, Card, Text, TextField } from '../ui'
import { useGiftCardText } from './use-gift-card-text'

/**
 * Adds a card to the account by its full code. The code is sent once and
 * dropped: the field is cleared as soon as the card is saved.
 */
export function ClaimCard({
	state,
	onClaim,
	onDismiss,
}: {
	state: GiftCardsClaimState
	onClaim: (code: string) => Promise<boolean>
	onDismiss: () => void
}) {
	const { i18n, label } = useGiftCardText()
	const [code, setCode] = useState('')
	const claiming = state.status === 'claiming'
	const submit = () => {
		if (claiming) return
		void onClaim(code).then((saved) => {
			if (saved) setCode('')
		})
	}
	return (
		<Card className="gap-3">
			<Text variant="heading" accessibilityRole="header">
				{label('addHeading')}
			</Text>
			<Text variant="muted">{label('addBody')}</Text>
			<TextField
				label={label('addCodeLabel')}
				hint={label('addCodeHint')}
				value={code}
				onChangeText={setCode}
				onSubmitEditing={submit}
				autoCapitalize="characters"
				autoCorrect={false}
				autoComplete="off"
				spellCheck={false}
				returnKeyType="done"
				editable={!claiming}
				error={state.error ? giftCardErrorText(i18n, state.error.code) : null}
			/>
			<Button loading={claiming} onPress={submit}>
				{label('addAction')}
			</Button>
			{state.savedLast4 ? (
				<View className="gap-2">
					<Text variant="body" accessibilityLiveRegion="polite">
						{label(state.alreadyMine ? 'addAlreadyMine' : 'addSaved', {
							last4: isolateLtr(state.savedLast4),
						})}
					</Text>
					<Button variant="ghost" size="sm" onPress={onDismiss}>
						{label('dismiss')}
					</Button>
				</View>
			) : null}
			<Text variant="caption">{label('addMoveNote')}</Text>
		</Card>
	)
}
