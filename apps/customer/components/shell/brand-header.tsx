import { Image, View } from 'react-native'
import { Text } from '../ui'

/** Branded chrome: the organization's icon and name. */
export function BrandHeader({
	name,
	iconUrl,
}: {
	name: string
	iconUrl: string | null
}) {
	return (
		<View
			className="border-border bg-background flex-row items-center gap-3 border-b px-5 py-3"
			accessibilityRole="header"
			accessible
		>
			{iconUrl ? (
				<Image
					source={{ uri: iconUrl }}
					className="h-9 w-9 rounded-md"
					resizeMode="contain"
					accessibilityIgnoresInvertColors
				/>
			) : null}
			<Text variant="heading" className="flex-1" numberOfLines={1}>
				{name}
			</Text>
		</View>
	)
}
