import React, { useEffect, useRef } from 'react'
import { Text, Animated, TouchableOpacity, StyleSheet } from 'react-native'

export interface ToastProps {
	message: string
	type?: 'error' | 'success' | 'warning' | 'info'
	visible: boolean
	duration?: number
	onHide: () => void
	position?: 'top' | 'bottom'
	className?: string
}

const toastStyles = {
	error: 'bg-red-50 border-l-4 border-l-destructive',
	success: 'bg-green-50 border-l-4 border-l-green-500',
	warning: 'bg-amber-50 border-l-4 border-l-amber-500',
	info: 'bg-blue-50 border-l-4 border-l-blue-500',
} as const

const textStyles = {
	error: 'text-red-600',
	success: 'text-green-600',
	warning: 'text-amber-600',
	info: 'text-blue-600',
} as const

const Toast: React.FC<ToastProps> = ({
	message,
	type = 'error',
	visible,
	duration = 4000,
	onHide,
	position = 'top',
}) => {
	const fadeAnim = useRef(new Animated.Value(0)).current
	const slideAnim = useRef(
		new Animated.Value(position === 'top' ? -100 : 100),
	).current

	const hideToast = React.useCallback(() => {
		Animated.parallel([
			Animated.timing(fadeAnim, {
				toValue: 0,
				duration: 300,
				useNativeDriver: true,
			}),
			Animated.timing(slideAnim, {
				toValue: position === 'top' ? -100 : 100,
				duration: 300,
				useNativeDriver: true,
			}),
		]).start(() => {
			onHide()
		})
	}, [fadeAnim, onHide, position, slideAnim])

	useEffect(() => {
		if (visible) {
			Animated.parallel([
				Animated.timing(fadeAnim, {
					toValue: 1,
					duration: 300,
					useNativeDriver: true,
				}),
				Animated.timing(slideAnim, {
					toValue: 0,
					duration: 300,
					useNativeDriver: true,
				}),
			]).start()

			const timer = setTimeout(() => {
				hideToast()
			}, duration)

			return () => clearTimeout(timer)
		} else {
			hideToast()
		}
	}, [visible, duration, fadeAnim, slideAnim, hideToast])

	if (!visible) {
		return null
	}

	return (
		<Animated.View
			// eslint-disable-next-line shadcn/no-inline-styles -- React Native animated values can only be passed through the style prop
			style={[
				styles.container,
				position === 'top' ? styles.topPosition : styles.bottomPosition,
				{
					opacity: fadeAnim,
					transform: [{ translateY: slideAnim }],
				},
			]}
		>
			<TouchableOpacity
				className={`rounded-lg px-4 py-3 shadow-md ${toastStyles[type]}`}
				onPress={hideToast}
				activeOpacity={0.9}
				accessibilityRole="button"
				accessibilityLabel="Dismiss notification"
			>
				<Text className={`text-center text-sm font-medium ${textStyles[type]}`}>
					{message}
				</Text>
			</TouchableOpacity>
		</Animated.View>
	)
}

const styles = StyleSheet.create({
	container: {
		position: 'absolute',
		left: 16,
		right: 16,
		zIndex: 9999,
	},
	topPosition: {
		top: 60,
	},
	bottomPosition: {
		bottom: 60,
	},
})

export { Toast }
