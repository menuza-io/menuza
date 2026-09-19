import React from 'react'
import {
	View,
	Text,
	Modal,
	TouchableOpacity,
	TouchableWithoutFeedback,
	Dimensions,
} from 'react-native'

export interface ErrorModalProps {
	visible: boolean
	title: string
	message: string
	type?: 'error' | 'warning' | 'info'
	primaryAction?: {
		text: string
		onPress: () => void
	}
	secondaryAction?: {
		text: string
		onPress: () => void
	}
	onDismiss?: () => void
	dismissible?: boolean
	className?: string
}

const iconContainerStyles = {
	error: 'bg-red-100',
	warning: 'bg-amber-100',
	info: 'bg-blue-100',
} as const

const ErrorModal: React.FC<ErrorModalProps> = ({
	visible,
	title,
	message,
	type = 'error',
	primaryAction,
	secondaryAction,
	onDismiss,
	dismissible = true,
}) => {
	const handleBackdropPress = () => {
		if (dismissible && onDismiss) {
			onDismiss()
		}
	}

	const getIcon = () => {
		switch (type) {
			case 'warning':
				return '⚠️'
			case 'info':
				return 'ℹ️'
			case 'error':
			default:
				return '❌'
		}
	}

	const { width } = Dimensions.get('window')
	const modalWidth = Math.min(width - 40, 400)

	return (
		<Modal
			visible={visible}
			transparent
			animationType="fade"
			onRequestClose={dismissible ? onDismiss : undefined}
		>
			<TouchableWithoutFeedback onPress={handleBackdropPress}>
				<View className="flex-1 items-center justify-center bg-black/50 p-5">
					<TouchableWithoutFeedback>
						<View
							className="bg-card rounded-xl p-6 shadow-lg"
							style={{ width: modalWidth }}
						>
							<View className="mb-4 items-center">
								<View
									className={`mb-3 h-12 w-12 items-center justify-center rounded-full ${iconContainerStyles[type]}`}
								>
									<Text className="text-2xl">{getIcon()}</Text>
								</View>
								<Text className="text-foreground text-center text-lg">
									{title}
								</Text>
							</View>

							<Text className="text-muted-foreground mb-6 text-center text-sm leading-5">
								{message}
							</Text>

							<View className="flex-row justify-end gap-3">
								{secondaryAction && (
									<TouchableOpacity
										className="bg-muted border-input min-w-20 items-center rounded-md border px-4 py-2.5"
										onPress={secondaryAction.onPress}
										accessibilityRole="button"
									>
										<Text className="text-foreground text-sm">
											{secondaryAction.text}
										</Text>
									</TouchableOpacity>
								)}

								{primaryAction && (
									<TouchableOpacity
										className="bg-destructive min-w-20 items-center rounded-md px-4 py-2.5"
										onPress={primaryAction.onPress}
										accessibilityRole="button"
									>
										<Text className="text-primary-foreground text-sm">
											{primaryAction.text}
										</Text>
									</TouchableOpacity>
								)}

								{!primaryAction && !secondaryAction && dismissible && (
									<TouchableOpacity
										className="bg-destructive min-w-20 items-center rounded-md px-4 py-2.5"
										onPress={onDismiss}
										accessibilityRole="button"
									>
										<Text className="text-primary-foreground text-sm">
											OK
										</Text>
									</TouchableOpacity>
								)}
							</View>
						</View>
					</TouchableWithoutFeedback>
				</View>
			</TouchableWithoutFeedback>
		</Modal>
	)
}

export { ErrorModal }
