import { useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import { AccessibilityInfo, View } from 'react-native'
import { type LoyaltyNotice } from '../../lib/loyalty/loyalty-store'
import { loyaltyNoticeText } from '../../lib/loyalty/notice-text'
import { Button, Card, Text } from '../ui'

/** The wallet's last outcome, announced once and dismissable. */
export function NoticeLine({
	notice,
	onDismiss,
}: {
	notice: LoyaltyNotice
	onDismiss: () => void
}) {
	const { i18n, t } = useLingui()
	const message = loyaltyNoticeText(i18n, notice)
	useEffect(() => {
		AccessibilityInfo.announceForAccessibility(message)
	}, [message])
	return (
		<Card className="flex-row items-center gap-3">
			<View className="flex-1">
				<Text
					variant={notice.kind === 'error' ? 'error' : 'body'}
					accessibilityLiveRegion="polite"
				>
					{message}
				</Text>
			</View>
			<Button variant="ghost" size="sm" onPress={onDismiss}>
				{t`Dismiss`}
			</Button>
		</Card>
	)
}

/** A standing condition of the program or membership (paused, on hold). */
export function StatusNote({ children }: { children: string }) {
	return (
		<Card className="bg-muted">
			<Text>{children}</Text>
		</Card>
	)
}

/** A titled wallet section. */
export function Section({
	title,
	children,
}: {
	title: string
	children: React.ReactNode
}) {
	return (
		<Card className="gap-3">
			<Text variant="heading" accessibilityRole="header">
				{title}
			</Text>
			{children}
		</Card>
	)
}
