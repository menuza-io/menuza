import { Plural, Trans } from '@lingui/react/macro'
import { type Blocker } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { type ReactNode } from 'react'

/**
 * What stops a unit change or a merge: an open count, an open transfer or an
 * order that is not closed. Said in the owner's words; the person finishes or
 * cancels them and tries again.
 */
export function BlockerList({
	blockers,
	title,
}: {
	blockers: readonly Blocker[]
	title: ReactNode
}) {
	const count = (kind: Blocker['kind']) =>
		blockers.filter((blocker) => blocker.kind === kind)
	const counts = count('open_count')
	const transfers = count('open_transfer')
	const orders = count('open_order')
	const deliveries = count('open_delivery')
	const prep = count('open_prep')
	const groups = [...count('in_group'), ...count('is_group')]
	return (
		<Alert variant="destructive" data-testid="blockers">
			<AlertDescription>
				<p className="font-medium">{title}</p>
				<ul className="mt-1 list-disc ps-5">
					{counts.length > 0 ? (
						<li data-testid="blocker-open_count">
							<Plural
								value={counts.length}
								one="A count is still open."
								other="# counts are still open."
							/>
						</li>
					) : null}
					{transfers.length > 0 ? (
						<li data-testid="blocker-open_transfer">
							<Plural
								value={transfers.length}
								one="A transfer is still open."
								other="# transfers are still open."
							/>
						</li>
					) : null}
					{orders.length > 0 ? (
						<li data-testid="blocker-open_order">
							<Trans>
								Not received yet:{' '}
								<bdi dir="ltr">
									{orders.map((order) => `#${order.reference}`).join(', ')}
								</bdi>
							</Trans>
						</li>
					) : null}
					{deliveries.length > 0 ? (
						<li data-testid="blocker-open_delivery">
							<Plural
								value={deliveries.length}
								one="A delivery is still a draft."
								other="# deliveries are still drafts."
							/>
						</li>
					) : null}
					{prep.length > 0 ? (
						<li data-testid="blocker-open_prep">
							<Plural
								value={prep.length}
								one="A prep task is still open."
								other="# prep tasks are still open."
							/>
						</li>
					) : null}
					{groups.length > 0 ? (
						<li data-testid="blocker-group">
							<Trans>
								This item is part of an ingredient group. Take it out of the
								group first.
							</Trans>
						</li>
					) : null}
				</ul>
			</AlertDescription>
		</Alert>
	)
}
