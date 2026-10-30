import React from 'react'
import { View, type ViewProps, StatusBar } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

interface ScreenProps extends ViewProps {
	children: React.ReactNode
	safeArea?: boolean
	statusBarStyle?: 'default' | 'light-content' | 'dark-content'
	backgroundColor?: string
	className?: string
}

const Screen: React.FC<ScreenProps> = ({
	children,
	safeArea = true,
	statusBarStyle = 'light-content',
	backgroundColor,
	className,
	...props
}) => {
	return (
		<>
			<StatusBar barStyle={statusBarStyle} />
			<View
				className={`flex-1 ${className ?? ''}`}
				style={backgroundColor ? { backgroundColor } : undefined}
				{...props}
			>
				{safeArea ? <SafeAreaView>{children}</SafeAreaView> : children}
			</View>
		</>
	)
}

export { Screen }
export type { ScreenProps }
