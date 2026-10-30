import { type ReactNode } from 'react'
import { View } from 'react-native'
import { Card, Screen, Text } from '../ui'

/** The one-card form layout every sign-in step uses. */
export function FormCard({
	title,
	subtitle,
	children,
}: {
	title: string
	subtitle?: string
	children: ReactNode
}) {
	return (
		<Screen scroll>
			<Card className="mt-5 gap-4">
				<View className="gap-1.5">
					<Text variant="heading" accessibilityRole="header">
						{title}
					</Text>
					{subtitle ? <Text variant="muted">{subtitle}</Text> : null}
				</View>
				{children}
			</Card>
		</Screen>
	)
}
