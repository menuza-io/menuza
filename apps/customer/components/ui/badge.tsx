import { View } from 'react-native'
import { Text } from './text'

/** A short status label in a muted pill. */
export function Badge({ children }: { children: string }) {
	return (
		<View className="bg-muted self-start rounded-full px-2.5 py-1">
			<Text className="text-foreground text-xs font-semibold">{children}</Text>
		</View>
	)
}
