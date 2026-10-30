import {
	ActivityIndicator,
	Pressable,
	type GestureResponderEvent,
	type PressableProps,
} from 'react-native'
import { Text } from './text'

export type ButtonVariant =
	'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive'
export type ButtonSize = 'sm' | 'default' | 'lg'

export const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
	primary: 'bg-primary border border-primary',
	secondary: 'bg-secondary border border-border',
	outline: 'bg-transparent border border-border',
	ghost: 'bg-transparent',
	destructive: 'bg-destructive border border-destructive',
}

export const BUTTON_TEXT_CLASSES: Record<ButtonVariant, string> = {
	primary: 'text-primary-foreground',
	secondary: 'text-secondary-foreground',
	outline: 'text-primary',
	ghost: 'text-primary',
	destructive: 'text-destructive-foreground',
}

export const BUTTON_SIZE_CLASSES: Record<ButtonSize, string> = {
	sm: 'h-9 px-3',
	default: 'h-11 px-4',
	lg: 'h-13 px-6',
}

export const BUTTON_TEXT_SIZE_CLASSES: Record<ButtonSize, string> = {
	sm: 'text-sm',
	default: 'text-base',
	lg: 'text-lg',
}

export type ButtonProps = Omit<PressableProps, 'children' | 'className'> & {
	children: PressableProps['children']
	variant?: ButtonVariant
	size?: ButtonSize
	loading?: boolean
	disabled?: boolean
	className?: string
}

export function Button({
	children,
	variant = 'primary',
	size = 'default',
	loading = false,
	disabled = false,
	className,
	onPress,
	...props
}: ButtonProps) {
	const isDisabled = disabled || loading
	const handlePress = (event: GestureResponderEvent) => {
		if (isDisabled) return
		onPress?.(event)
	}
	return (
		<Pressable
			className={`flex-row items-center justify-center rounded-lg ${BUTTON_VARIANT_CLASSES[variant]} ${BUTTON_SIZE_CLASSES[size]}${isDisabled ? 'opacity-50' : ''}${className ? ` ${className}` : ''}`}
			onPress={handlePress}
			disabled={isDisabled}
			accessibilityRole="button"
			accessibilityState={{ disabled: isDisabled, busy: loading }}
			// The spinner replaces the label, so the name must not go with it.
			accessibilityLabel={typeof children === 'string' ? children : undefined}
			{...props}
		>
			{loading ? (
				<ActivityIndicator
					size="small"
					colorClassName={
						variant === 'primary'
							? 'accent-primary-foreground'
							: variant === 'destructive'
								? 'accent-destructive-foreground'
								: 'accent-primary'
					}
				/>
			) : typeof children === 'string' ? (
				<Text
					className={`font-medium ${BUTTON_TEXT_CLASSES[variant]} ${BUTTON_TEXT_SIZE_CLASSES[size]}`}
				>
					{children}
				</Text>
			) : (
				children
			)}
		</Pressable>
	)
}
