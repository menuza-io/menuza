import { Pressable, View } from 'react-native'
import { Text } from './text'

/** Announcement severity, mapped like the Sites announcement banner. */
export type BannerKind = 'info' | 'warning' | 'error'

export const BANNER_KIND_CLASSES: Record<BannerKind, string> = {
	info: 'bg-primary',
	warning: 'bg-accent',
	error: 'bg-destructive',
}

export const BANNER_TEXT_CLASSES: Record<BannerKind, string> = {
	info: 'text-primary-foreground',
	warning: 'text-accent-foreground',
	error: 'text-destructive-foreground',
}

export function Banner({
	kind = 'info',
	children,
	actionLabel,
	onAction,
	className,
}: {
	kind?: BannerKind
	children: string
	/** A "Learn more"-style link, rendered only with a handler. */
	actionLabel?: string
	onAction?: () => void
	className?: string
}) {
	return (
		<View
			className={`flex-row items-center justify-between gap-3 px-4 py-3 ${BANNER_KIND_CLASSES[kind]}${className ? ` ${className}` : ''}`}
			accessibilityLiveRegion="polite"
		>
			<Text
				className={`flex-1 text-sm font-medium ${BANNER_TEXT_CLASSES[kind]}`}
			>
				{children}
			</Text>
			{actionLabel && onAction ? (
				<Pressable
					onPress={onAction}
					accessibilityRole="link"
					className="rounded-sm"
				>
					<Text
						className={`text-sm font-semibold underline ${BANNER_TEXT_CLASSES[kind]}`}
					>
						{actionLabel}
					</Text>
				</Pressable>
			) : null}
		</View>
	)
}
