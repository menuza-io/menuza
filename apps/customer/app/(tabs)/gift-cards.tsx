import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { GiftCardsScreen } from '../../components/gift-cards/gift-cards-screen'

export default function GiftCardsRoute() {
	const [focused, setFocused] = useState(true)
	useFocusEffect(
		useCallback(() => {
			setFocused(true)
			return () => setFocused(false)
		}, []),
	)
	return <GiftCardsScreen focused={focused} />
}
