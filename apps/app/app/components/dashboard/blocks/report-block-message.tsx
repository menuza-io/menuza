import { Icon, type IconName } from '@repo/ui/icon'
import { type ReactNode } from 'react'

/** A state a report block shows instead of its result, such as no access. */
export function ReportBlockMessage({
	icon,
	title,
	children,
}: {
	icon: IconName
	title: ReactNode
	children: ReactNode
}) {
	return (
		// Auto margins center the message but still let it scroll in a small
		// block, which centering the flex container would cut off.
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
			<div className="my-auto flex flex-col items-center gap-1 text-center">
				<Icon name={icon} className="text-muted-foreground size-5" />
				<p className="text-foreground font-medium">{title}</p>
				<p className="text-muted-foreground max-w-xs text-xs leading-relaxed">
					{children}
				</p>
			</div>
		</div>
	)
}
