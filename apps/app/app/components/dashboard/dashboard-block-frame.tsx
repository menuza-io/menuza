import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { type ReactNode } from 'react'

/** The only element a block can be dragged by while the layout is edited. */
export const DRAG_HANDLE_SELECTOR = '[data-dashboard-drag-handle]'

/**
 * The chrome shared by every dashboard block. Block contents draw their own
 * card, so the frame only names the block and makes it fill its grid cell.
 * While the layout is edited it adds a small toolbar on the top edge with the
 * drag handle and the remove button.
 */
export function DashboardBlockFrame({
	title,
	editing = false,
	onRemove,
	children,
}: {
	title: string
	editing?: boolean
	onRemove?: () => void
	children: ReactNode
}) {
	const { _ } = useLingui()
	return (
		<section
			aria-label={title}
			className="relative flex h-full min-h-0 flex-col"
		>
			{editing ? (
				<div className="bg-background absolute -top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border p-0.5 shadow-sm">
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="cursor-grab touch-none active:cursor-grabbing"
						aria-label={_(msg`Move block`)}
						title={_(msg`Drag to move`)}
						data-dashboard-drag-handle=""
					>
						<Icon name="grip-vertical" />
					</Button>
					{onRemove ? (
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={_(msg`Remove block`)}
							title={_(msg`Remove block`)}
							onClick={onRemove}
						>
							<Icon name="x" />
						</Button>
					) : null}
				</div>
			) : null}
			<div className="min-h-0 flex-1">{children}</div>
		</section>
	)
}
