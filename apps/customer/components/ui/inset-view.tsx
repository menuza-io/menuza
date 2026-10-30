import { View, type ViewProps } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

export type InsetEdge = 'top' | 'bottom'

/**
 * Pads its content clear of the notch or the home indicator. The app shell
 * owns the top edge (above the brand header); screens outside the tab bar
 * own the bottom one.
 */
export function InsetView({
	edges,
	className,
	children,
	...props
}: ViewProps & { edges: readonly InsetEdge[]; className?: string }) {
	const insets = useSafeAreaInsets()
	return (
		<View
			className={className}
			style={{
				paddingTop: edges.includes('top') ? insets.top : 0,
				paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
			}}
			{...props}
		>
			{children}
		</View>
	)
}
