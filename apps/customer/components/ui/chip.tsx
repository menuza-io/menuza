import { Pressable } from 'react-native'
import { Text } from './text'

/**
 * A selectable pill: a time, a day of the date strip, an option of a short
 * list. At least 44 points tall. As a `radio` it reports `checked`, as a
 * `button` it reports `selected`.
 */
export function Chip({
	label,
	sublabel,
	selected = false,
	disabled = false,
	role = 'button',
	accessibilityLabel,
	onPress,
}: {
	label: string
	/** A smaller line above the label (the weekday above a day number). */
	sublabel?: string
	selected?: boolean
	disabled?: boolean
	role?: 'button' | 'radio'
	accessibilityLabel?: string
	onPress: () => void
}) {
	return (
		<Pressable
			accessibilityRole={role}
			accessibilityState={
				role === 'radio'
					? { checked: selected, disabled }
					: { selected, disabled }
			}
			accessibilityLabel={
				accessibilityLabel ?? (sublabel ? `${sublabel} ${label}` : label)
			}
			disabled={disabled}
			onPress={() => {
				if (!disabled) onPress()
			}}
			className={`min-h-11 min-w-14 items-center justify-center rounded-lg border px-3 py-1.5 ${selected ? 'border-primary bg-primary' : 'border-border bg-card'}${disabled ? 'opacity-50' : ''}`}
		>
			{sublabel ? (
				<Text
					className={`text-xs ${selected ? 'text-primary-foreground' : 'text-muted-foreground'}`}
				>
					{sublabel}
				</Text>
			) : null}
			<Text
				className={`text-sm font-semibold ${selected ? 'text-primary-foreground' : 'text-foreground'}`}
			>
				{label}
			</Text>
		</Pressable>
	)
}
