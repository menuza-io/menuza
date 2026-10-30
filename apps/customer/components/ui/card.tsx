import { View, type ViewProps } from 'react-native'

export function Card({
	children,
	className,
	...props
}: ViewProps & { className?: string }) {
	return (
		<View
			className={`border-border bg-card rounded-xl border p-4${className ? ` ${className}` : ''}`}
			{...props}
		>
			{children}
		</View>
	)
}
