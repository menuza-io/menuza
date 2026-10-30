import { View } from 'react-native'
import { Button } from './button'
import { Text } from './text'

export function EmptyState({
	title,
	body,
	actionLabel,
	onAction,
}: {
	title: string
	body?: string
	actionLabel?: string
	onAction?: () => void
}) {
	return (
		<View className="items-center gap-2 p-8">
			<Text variant="heading" className="text-center">
				{title}
			</Text>
			{body ? (
				<Text variant="muted" className="text-center">
					{body}
				</Text>
			) : null}
			{actionLabel && onAction ? (
				<Button variant="outline" className="mt-2" onPress={onAction}>
					{actionLabel}
				</Button>
			) : null}
		</View>
	)
}
