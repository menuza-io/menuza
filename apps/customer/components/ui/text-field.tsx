import { TextInput, View, type TextInputProps } from 'react-native'
import { Text } from './text'

export type TextFieldProps = TextInputProps & {
	label?: string
	/** An error message; the field shows it and marks itself invalid. */
	error?: string | null
	/** Shown while there is no error. */
	hint?: string
	containerClassName?: string
}

export function TextField({
	label,
	error,
	hint,
	containerClassName,
	...props
}: TextFieldProps) {
	return (
		<View className={containerClassName}>
			{label ? (
				<Text
					variant="label"
					className="mb-1.5"
					nativeID={props.id ? `${props.id}-label` : undefined}
				>
					{label}
				</Text>
			) : null}
			<TextInput
				className={`bg-background text-foreground h-12 rounded-lg border px-3 text-base ${error ? 'border-destructive' : 'border-input'}`}
				placeholderTextColorClassName="accent-muted-foreground"
				cursorColorClassName="accent-primary"
				accessibilityLabel={props.accessibilityLabel ?? label}
				{...props}
			/>
			{error ? (
				<Text variant="error" className="mt-1" accessibilityLiveRegion="polite">
					{error}
				</Text>
			) : hint ? (
				<Text variant="muted" className="mt-1">
					{hint}
				</Text>
			) : null}
		</View>
	)
}
