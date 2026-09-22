import { Trans } from '@lingui/macro'
import {
	formatUnavailableUntil,
	isUnavailableUntilExpired,
} from '@repo/common/menu-types'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'

export interface MenuStatusBadgeProps {
	status: string | null | undefined
	unavailableUntil?: Date | string | number | null
	timezone?: string
	className?: string
}

export function MenuStatusBadge({
	status,
	unavailableUntil,
	timezone,
	className,
}: MenuStatusBadgeProps) {
	const isExpired = isUnavailableUntilExpired(status, unavailableUntil)
	const isAvailable = status === 'available' || !status || isExpired
	const isUnavailableUntil =
		!isExpired &&
		(status === 'unavailable_until' || status === 'unavailable_until_tomorrow')

	const formattedUntil =
		isUnavailableUntil && unavailableUntil
			? formatUnavailableUntil(unavailableUntil, timezone)
			: null

	return (
		<Badge
			variant={isAvailable ? 'outline' : 'secondary'}
			className={cn('text-xs font-medium', className)}
		>
			<span
				className={cn(
					'mr-1.5 size-1.5 rounded-full',
					isAvailable
						? 'bg-emerald-500'
						: isUnavailableUntil
							? 'bg-amber-500'
							: 'bg-muted-foreground',
				)}
			/>
			{isAvailable ? (
				<Trans>Available</Trans>
			) : isUnavailableUntil ? (
				formattedUntil ? (
					<span>
						<Trans>Unavailable until {formattedUntil}</Trans>
					</span>
				) : (
					<Trans>Unavailable until</Trans>
				)
			) : (
				<Trans>Unavailable</Trans>
			)}
		</Badge>
	)
}
