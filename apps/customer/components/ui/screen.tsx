import { RefreshControl, ScrollView, View, type ViewProps } from 'react-native'

export type ScreenProps = ViewProps & {
	/** Scroll the content (forms, long lists); off for fixed layouts. */
	scroll?: boolean
	/** Horizontal padding; off for full-bleed content like lists with dividers. */
	padded?: boolean
	/** Pull to refresh, on a scrolling screen. */
	onRefresh?: () => void
	refreshing?: boolean
	className?: string
}

/**
 * A screen surface in the organization's background color. Safe areas belong
 * to the shell (top) and to the tab bar or `InsetView` (bottom), so a screen
 * never pads them twice.
 */
export function Screen({
	children,
	scroll = false,
	padded = true,
	onRefresh,
	refreshing = false,
	className,
	...props
}: ScreenProps) {
	const padding = padded ? { paddingHorizontal: 20 } : undefined
	return (
		<View
			className={`flex-1 bg-background${className ? ` ${className}` : ''}`}
			{...props}
		>
			{scroll ? (
				<ScrollView
					className="flex-1"
					contentContainerStyle={{ ...padding, paddingBottom: 24 }}
					keyboardShouldPersistTaps="handled"
					refreshControl={
						onRefresh ? (
							<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
						) : undefined
					}
				>
					{children}
				</ScrollView>
			) : (
				<View className="flex-1" style={padding}>
					{children}
				</View>
			)}
		</View>
	)
}
