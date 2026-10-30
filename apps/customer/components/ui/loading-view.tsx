import { ActivityIndicator, View } from 'react-native'
import { Text } from './text'

export function LoadingView({ label }: { label?: string }) {
	return (
		<View className="flex-1 items-center justify-center gap-3 p-8">
			<ActivityIndicator size="large" colorClassName="accent-primary" />
			{label ? (
				<Text variant="muted" className="text-center">
					{label}
				</Text>
			) : null}
		</View>
	)
}
