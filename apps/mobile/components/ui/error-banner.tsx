import React from 'react'
import { View, Text, TouchableOpacity, type ViewProps } from 'react-native'

export interface ErrorBannerProps extends ViewProps {
	message: string
	type?: 'error' | 'warning' | 'info'
	dismissible?: boolean
	onDismiss?: () => void
	actionText?: string
	onAction?: () => void
	persistent?: boolean
	className?: string
}

const bannerStyles = {
	error: 'bg-red-50 border-l-destructive',
	warning: 'bg-amber-50 border-l-amber-500',
	info: 'bg-blue-50 border-l-blue-500',
} as const

const textStyles = {
	error: 'text-red-600',
	warning: 'text-amber-600',
	info: 'text-blue-600',
} as const

const actionStyles = {
	error: 'bg-red-100',
	warning: 'bg-amber-100',
	info: 'bg-blue-100',
} as const

const ErrorBanner: React.FC<ErrorBannerProps> = ({
	message,
	type = 'error',
	dismissible = false,
	onDismiss,
	actionText,
	onAction,
	persistent: _persistent = false,
	className,
	...props
}) => {
	return (
		<View
			className={`mx-4 my-2 rounded-lg border-l-4 px-4 py-3 ${bannerStyles[type]} ${className ?? ''}`}
			{...props}
		>
			<View className="flex-row items-center justify-between">
				<Text className={`mr-3 flex-1 text-sm font-medium ${textStyles[type]}`}>
					{message}
				</Text>

				<View className="flex-row items-center">
					{actionText && onAction && (
						<TouchableOpacity
							className={`mr-2 rounded px-3 py-1.5 ${actionStyles[type]}`}
							onPress={onAction}
							accessibilityRole="button"
							accessibilityLabel={actionText}
						>
							<Text className={`text-xs ${textStyles[type]}`}>
								{actionText}
							</Text>
						</TouchableOpacity>
					)}

					{dismissible && onDismiss && (
						<TouchableOpacity
							className="px-2 py-1"
							onPress={onDismiss}
							accessibilityRole="button"
							accessibilityLabel="Dismiss"
						>
							<Text className={`text-lg font-bold ${textStyles[type]}`}>×</Text>
						</TouchableOpacity>
					)}
				</View>
			</View>
		</View>
	)
}

export { ErrorBanner }
