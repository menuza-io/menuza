import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Icon } from '@repo/ui/icon'
import {
	type SocialPlatform,
	type SocialPostStatus,
	type SocialTargetStatus,
} from '#app/utils/social/platforms.ts'
import {
	SOCIAL_PLATFORM_LABELS,
	SOCIAL_POST_STATUS_LABELS,
	SOCIAL_TARGET_STATUS_LABELS,
} from './social-labels.ts'

type BadgeVariant =
	'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline'

export const SOCIAL_POST_STATUS_VARIANTS: Record<
	SocialPostStatus,
	BadgeVariant
> = {
	draft: 'secondary',
	scheduled: 'default',
	publishing: 'outline',
	published: 'success',
	partial: 'warning',
	failed: 'destructive',
}

const TARGET_STATUS_VARIANTS: Record<SocialTargetStatus, BadgeVariant> = {
	pending: 'secondary',
	publishing: 'outline',
	published: 'success',
	failed: 'destructive',
}

export function SocialPlatformIcon({
	platform,
	className,
}: {
	platform: SocialPlatform
	className?: string
}) {
	const { _ } = useLingui()
	return (
		<Icon
			name={platform}
			className={className ?? 'size-4'}
			aria-label={_(SOCIAL_PLATFORM_LABELS[platform])}
		/>
	)
}

export function SocialPostStatusBadge({
	status,
}: {
	status: SocialPostStatus
}) {
	const { _ } = useLingui()
	return (
		<Badge variant={SOCIAL_POST_STATUS_VARIANTS[status]}>
			{_(SOCIAL_POST_STATUS_LABELS[status])}
		</Badge>
	)
}

export function SocialTargetStatusBadge({
	status,
}: {
	status: SocialTargetStatus
}) {
	const { _ } = useLingui()
	return (
		<Badge variant={TARGET_STATUS_VARIANTS[status]}>
			{_(SOCIAL_TARGET_STATUS_LABELS[status])}
		</Badge>
	)
}
