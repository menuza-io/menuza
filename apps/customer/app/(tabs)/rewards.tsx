import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { RewardsScreen } from '../../components/loyalty/rewards-screen'

export default function RewardsRoute() {
	const [focused, setFocused] = useState(true)
	useFocusEffect(
		useCallback(() => {
			setFocused(true)
			return () => setFocused(false)
		}, []),
	)
	return <RewardsScreen focused={focused} />
}
