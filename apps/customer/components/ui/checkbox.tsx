import { Pressable, View } from 'react-native'
import { Text } from './text'

/** A labelled checkbox; the whole row toggles it. */
export function Checkbox({
	checked,
	onChange,
	label,
	disabled = false,
}: {
	checked: boolean
	onChange: (checked: boolean) => void
	label: string
	disabled?: boolean
}) {
	return (
		<Pressable
			accessibilityRole="checkbox"
			accessibilityState={{ checked, disabled }}
			accessibilityLabel={label}
			disabled={disabled}
			onPress={() => {
				if (!disabled) onChange(!checked)
			}}
			className={`flex-row items-start gap-3 py-2${disabled ? 'opacity-50' : ''}`}
		>
			<View
				className={`mt-0.5 h-5 w-5 items-center justify-center rounded border-2 ${checked ? 'border-primary bg-primary' : 'border-input bg-background'}`}
			>
				{checked ? (
					<Text className="text-primary-foreground text-xs font-bold">✓</Text>
				) : null}
			</View>
			<Text className="flex-1">{label}</Text>
		</Pressable>
	)
}
