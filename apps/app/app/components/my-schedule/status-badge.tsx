import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'

/**
 * A request's state, in words (never colour alone): waiting for a manager,
 * approved, not approved or cancelled.
 */
export function RequestStatus({ status }: { status: string }) {
	const { _ } = useLingui()
	const label =
		status === 'approved'
			? _(t`Approved`)
			: status === 'rejected'
				? _(t`Not approved`)
				: status === 'cancelled'
					? _(t`Cancelled`)
					: _(t`Waiting for a manager`)
	return (
		<Badge
			variant={
				status === 'approved'
					? 'default'
					: status === 'rejected'
						? 'destructive'
						: 'outline'
			}
		>
			{label}
		</Badge>
	)
}
