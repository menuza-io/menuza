import { useLingui } from '@lingui/react/macro'
import React, { useEffect, useRef } from 'react'
import { View, Text, Animated, Easing, StyleSheet } from 'react-native'

export interface SuccessAnimationProps {
	visible: boolean
	message?: string
	onComplete?: () => void
	duration?: number
	className?: string
}

const SuccessAnimation: React.FC<SuccessAnimationProps> = ({
	visible,
	message,
	onComplete,
	duration = 2000,
}) => {
	const { t } = useLingui()
	const displayMessage = message ?? t`Success!`
	const scaleAnim = useRef(new Animated.Value(0)).current
	const opacityAnim = useRef(new Animated.Value(0)).current

	useEffect(() => {
		if (visible) {
			Animated.sequence([
				Animated.parallel([
					Animated.timing(scaleAnim, {
						toValue: 1,
						duration: 300,
						easing: Easing.elastic(1.2),
						useNativeDriver: true,
					}),
					Animated.timing(opacityAnim, {
						toValue: 1,
						duration: 200,
						useNativeDriver: true,
					}),
				]),
				Animated.delay(duration - 500),
				Animated.timing(opacityAnim, {
					toValue: 0,
					duration: 200,
					useNativeDriver: true,
				}),
			]).start(() => {
				scaleAnim.setValue(0)
				onComplete?.()
			})
		}
	}, [visible, scaleAnim, opacityAnim, duration, onComplete])

	if (!visible) return null

	return (
		<View
			// eslint-disable-next-line shadcn/no-inline-styles -- React Native animated values can only be passed through the style prop
			style={styles.overlay}
			className="items-center justify-center"
			accessibilityLabel={t`Success`}
			accessible={true}
		>
			<Animated.View
				// eslint-disable-next-line shadcn/no-inline-styles -- React Native animated values can only be passed through the style prop
				style={[
					{
						transform: [{ scale: scaleAnim }],
						opacity: opacityAnim,
					},
				]}
				className="bg-card items-center rounded-2xl p-8 shadow-lg"
			>
				<Text className="mb-3 text-5xl text-green-500">✓</Text>
				<Text className="text-foreground text-center text-lg">
					{displayMessage}
				</Text>
			</Animated.View>
		</View>
	)
}

const styles = StyleSheet.create({
	overlay: {
		position: 'absolute',
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		backgroundColor: 'rgba(0, 0, 0, 0.3)',
		zIndex: 1000,
	},
})

export { SuccessAnimation }
