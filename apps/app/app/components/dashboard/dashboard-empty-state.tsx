import { Trans } from '@lingui/macro'
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { type ReactNode } from 'react'

/**
 * Shown in place of the grid while a dashboard has no blocks. `addBlock` is
 * the call to action for viewers who can add blocks right now; `editing` says
 * the edit toolbar already offers one.
 */
export function DashboardEmptyState({
	addBlock,
	editing = false,
}: {
	addBlock?: ReactNode
	editing?: boolean
}) {
	return (
		<div className="rounded-xl border border-dashed py-6">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<Icon name="layout-grid" />
					</EmptyMedia>
					<EmptyTitle>
						<Trans>This dashboard has no blocks yet</Trans>
					</EmptyTitle>
					<EmptyDescription>
						{editing ? (
							<Trans>
								Use Add block to put stats, charts and reports on it.
							</Trans>
						) : addBlock ? (
							<Trans>Add stats, charts and reports to build it.</Trans>
						) : (
							<Trans>Blocks added to this dashboard show up here.</Trans>
						)}
					</EmptyDescription>
				</EmptyHeader>
				{addBlock && !editing ? <EmptyContent>{addBlock}</EmptyContent> : null}
			</Empty>
		</div>
	)
}
