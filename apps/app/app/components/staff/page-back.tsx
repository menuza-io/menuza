import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { type ReactNode } from 'react'
import { Link } from 'react-router'

/**
 * A page header with the app's back pattern: an icon button to the left of the
 * title, never a button among the actions on the right.
 */
export function PageWithBack({
	to,
	label,
	children,
}: {
	to: string
	label: string
	children: ReactNode
}) {
	const { _ } = useLingui()
	return (
		<div className="flex items-start gap-3">
			<Button
				variant="outline"
				size="icon"
				render={<Link to={to} />}
				aria-label={_(t`Back to ${label}`)}
			>
				<Icon name="arrow-left" className="rtl:rotate-180" />
			</Button>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	)
}
