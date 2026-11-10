import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { type CountStatus } from '@repo/inventory'
import { Badge } from '@repo/ui/badge'

const STATUS = {
	counting: { label: msg`Counting`, variant: 'secondary' },
	in_review: { label: msg`In review`, variant: 'warning' },
	approved: { label: msg`Approved`, variant: 'success' },
	cancelled: { label: msg`Cancelled`, variant: 'outline' },
} as const

/** One badge per count state, in owner words. */
export function CountStatusBadge({ status }: { status: CountStatus }) {
	const { i18n } = useLingui()
	const entry = STATUS[status]
	return (
		<Badge variant={entry.variant} data-testid={`count-status-${status}`}>
			{i18n._(entry.label)}
		</Badge>
	)
}
