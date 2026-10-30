import { Ionicons } from '@expo/vector-icons'
import React, { forwardRef } from 'react'
import {
	TextInput,
	type TextInputProps,
	View,
	Text,
	TouchableOpacity,
	type TextInputInstance,
} from 'react-native'
import { getKeyboardConfig, type InputType } from '../../lib/keyboard'

export interface InputProps extends Omit<TextInputProps, 'style'> {
	label?: string
	error?: boolean | string
	disabled?: boolean
	rightIcon?: React.ReactNode | string
	onRightIconPress?: () => void
	rightIconAccessibilityLabel?: string
	className?: string
	inputType?: InputType
	onSubmitEditing?: () => void
	nextInputRef?: React.RefObject<TextInputInstance | null>
}

const Input = forwardRef<TextInputInstance, InputProps>(
	(
		{
			label,
			error,
			disabled,
			rightIcon,
			onRightIconPress,
			rightIconAccessibilityLabel,
			className,
			inputType = 'text',
			onSubmitEditing,
			nextInputRef,
			...props
		},
		ref,
	) => {
		const hasError = Boolean(error)
		const keyboardConfig = getKeyboardConfig(inputType)

		const handleSubmitEditing = () => {
			if (onSubmitEditing) {
				onSubmitEditing()
			} else if (nextInputRef?.current) {
				nextInputRef.current.focus()
			}
		}

		return (
			<View className={className}>
				{label && (
					<Text className="text-foreground mb-1.5 text-sm font-medium">
						{label}
					</Text>
				)}
				<View className="relative flex-row items-center">
					<TextInput
						ref={ref}
						className={`bg-background text-foreground h-11 flex-1 rounded-lg border px-3 text-base ${
							hasError ? 'border-destructive border-[1.5px]' : 'border-input'
						} ${disabled ? 'bg-muted text-muted-foreground' : ''} ${
							rightIcon ? 'pr-11' : ''
						}`}
						placeholderTextColor="#9CA3AF"
						editable={!disabled}
						keyboardType={keyboardConfig.keyboardType}
						autoCapitalize={keyboardConfig.autoCapitalize}
						autoCorrect={keyboardConfig.autoCorrect}
						returnKeyType={keyboardConfig.returnKeyType}
						textContentType={
							keyboardConfig.textContentType as TextInputProps['textContentType']
						}
						autoComplete={
							keyboardConfig.autoComplete as TextInputProps['autoComplete']
						}
						onSubmitEditing={handleSubmitEditing}
						accessibilityLabel={label || props.placeholder}
						{...props}
					/>
					{rightIcon && (
						<TouchableOpacity
							className="absolute right-3 h-11 items-center justify-center"
							onPress={onRightIconPress}
							disabled={!onRightIconPress}
							accessibilityLabel={rightIconAccessibilityLabel || 'Input action'}
							accessibilityRole="button"
						>
							{typeof rightIcon === 'string' ? (
								<Ionicons
									name={rightIcon as keyof typeof Ionicons.glyphMap}
									size={20}
									color="#6B7280"
								/>
							) : (
								rightIcon
							)}
						</TouchableOpacity>
					)}
				</View>
				{typeof error === 'string' && error && (
					<Text className="text-destructive mt-1 text-xs">{error}</Text>
				)}
			</View>
		)
	},
)

Input.displayName = 'Input'

export { Input }
