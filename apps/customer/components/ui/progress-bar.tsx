import { View } from 'react-native'

/**
 * A determinate bar. `label` names what progresses; `valueText` is the
 * spoken amount (a localized percent), since screen readers otherwise read
 * the raw number.
 */
export function ProgressBar({
	percent,
	label,
	valueText,
}: {
	/** 0–100; clamped. */
	percent: number
	label: string
	valueText?: string
}) {
	const value = Math.min(100, Math.max(0, Math.round(percent)))
	return (
		<View
			accessible
			accessibilityRole="progressbar"
			accessibilityLabel={label}
			accessibilityValue={{ min: 0, max: 100, now: value, text: valueText }}
			className="bg-muted h-2 w-full overflow-hidden rounded-full"
		>
			<View
				className="bg-primary h-full rounded-full"
				style={{ width: `${value}%` }}
			/>
		</View>
	)
}
