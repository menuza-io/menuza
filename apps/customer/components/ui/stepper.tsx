import { Pressable, View } from 'react-native'
import { Text } from './text'

/**
 * A number picked with minus and plus buttons, each named for screen
 * readers; the value is announced when it changes.
 */
export function Stepper({
	label,
	value,
	valueText,
	min,
	max,
	decrementLabel,
	incrementLabel,
	disabled = false,
	onChange,
}: {
	label: string
	value: number
	/** The value in words ("4 guests"). */
	valueText: string
	min: number
	max: number
	decrementLabel: string
	incrementLabel: string
	disabled?: boolean
	onChange: (value: number) => void
}) {
	const canDecrement = !disabled && value > min
	const canIncrement = !disabled && value < max
	return (
		<View className="flex-row items-center gap-3">
			<Text variant="label" className="flex-1">
				{label}
			</Text>
			<StepButton
				symbol="−"
				label={decrementLabel}
				enabled={canDecrement}
				onPress={() => onChange(Math.max(min, value - 1))}
			/>
			<Text
				className="text-foreground min-w-20 text-center text-base font-semibold"
				accessibilityLiveRegion="polite"
			>
				{valueText}
			</Text>
			<StepButton
				symbol="+"
				label={incrementLabel}
				enabled={canIncrement}
				onPress={() => onChange(Math.min(max, value + 1))}
			/>
		</View>
	)
}

function StepButton({
	symbol,
	label,
	enabled,
	onPress,
}: {
	symbol: string
	label: string
	enabled: boolean
	onPress: () => void
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={{ disabled: !enabled }}
			disabled={!enabled}
			onPress={() => {
				if (enabled) onPress()
			}}
			className={`border-border h-11 w-11 items-center justify-center rounded-full border bg-card${enabled ? '' : 'opacity-40'}`}
		>
			<Text className="text-foreground text-xl font-semibold">{symbol}</Text>
		</Pressable>
	)
}
