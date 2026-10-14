import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'

export type BulkOp = 'approve' | 'lock' | 'unlock' | 'reopen' | 'review'

export type BulkCounts = Record<BulkOp, number>

/**
 * What can be done to the cards that are ticked. It only offers an action that
 * at least one ticked card can take, with how many, so "Approve 4" is exactly
 * what will happen. It stays in reach at the bottom of the list while scrolling.
 */
export function BulkBar({
	selectedCount,
	counts,
	busy,
	onAction,
	onClear,
}: {
	selectedCount: number
	counts: BulkCounts
	busy: boolean
	onAction: (op: BulkOp) => void
	onClear: () => void
}) {
	const { _ } = useLingui()
	if (selectedCount === 0) return null
	const {
		review: reviewCount,
		approve: approveCount,
		lock: lockCount,
		reopen: reopenCount,
		unlock: unlockCount,
	} = counts
	const none = Object.values(counts).every((count) => count === 0)
	return (
		<div
			role="region"
			aria-label={_(t`Selected cards`)}
			className="bg-background border-border sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-xl border p-2 shadow-md"
		>
			<p className="ps-2 text-sm font-medium" aria-live="polite">
				{plural(selectedCount, {
					one: '# card selected',
					other: '# cards selected',
				})}
			</p>
			<div className="ms-auto flex flex-wrap items-center gap-2">
				{counts.review > 0 ? (
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => onAction('review')}
					>
						<Icon name="check" />
						<Trans>Looks right ({reviewCount})</Trans>
					</Button>
				) : null}
				{counts.approve > 0 ? (
					<Button disabled={busy} onClick={() => onAction('approve')}>
						<Icon name="circle-check" />
						<Trans>Approve ({approveCount})</Trans>
					</Button>
				) : null}
				{counts.lock > 0 ? (
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => onAction('lock')}
					>
						<Icon name="lock" />
						<Trans>Lock ({lockCount})</Trans>
					</Button>
				) : null}
				{counts.reopen > 0 ? (
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => onAction('reopen')}
					>
						<Icon name="undo-2" />
						<Trans>Reopen ({reopenCount})</Trans>
					</Button>
				) : null}
				{counts.unlock > 0 ? (
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => onAction('unlock')}
					>
						<Icon name="unlock" />
						<Trans>Unlock ({unlockCount})</Trans>
					</Button>
				) : null}
				{none ? (
					<span className="text-muted-foreground text-sm">
						<Trans>Nothing to do with these.</Trans>
					</span>
				) : null}
				<Button variant="ghost" onClick={onClear}>
					<Trans>Clear</Trans>
				</Button>
			</div>
		</div>
	)
}
