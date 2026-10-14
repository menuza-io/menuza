import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type StaffStatus as Status } from '@repo/staffing'

/**
 * Status as a small dot plus plain text. Only states that need attention get a
 * stronger dot; an active person stays quiet.
 */
export function StaffStatusLabel({ status }: { status: Status }) {
	const { _ } = useLingui()
	const label = {
		active: _(t`Active`),
		invited: _(t`Invited`),
		on_leave: _(t`On leave`),
		terminated: _(t`Left the team`),
	}[status]
	const dot = {
		active: 'bg-primary',
		invited: 'bg-muted-foreground/50',
		on_leave: 'bg-muted-foreground',
		terminated: 'bg-destructive/70',
	}[status]
	return (
		<span className="text-muted-foreground inline-flex items-center gap-2 text-sm">
			<span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} />
			{label}
		</span>
	)
}
