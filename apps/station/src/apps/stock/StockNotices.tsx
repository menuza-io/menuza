import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { needsSignIn, pauseText, retryText } from './messages.ts'
import { type StockState } from './useStock.ts'
import { Button } from '~/ui/primitives.tsx'

/**
 * What the person should know about Stock right now, in plain words: no
 * location, no stock list yet, an old list (still usable), a refused refresh,
 * a sign-in that cannot send, sending on hold, an outage. Quiet when all is
 * well. Used on Stock's home and inside the waste sheet.
 */
export function StockNotices({
	stock,
	compact = false,
	onSignIn,
	onOpenSync,
}: {
	stock: StockState
	compact?: boolean
	onSignIn?: () => void
	onOpenSync?: () => void
}) {
	const { _, i18n } = useLingui()
	const { catalog, stale, checkedAt, syncState, stats, reachable } = stock
	const notices: Array<{
		key: string
		icon: 'cloud-off' | 'alert-triangle' | 'clock'
		text: string
		action?: React.ReactNode
	}> = []

	if (!catalog && !stock.loading) {
		notices.push({
			key: 'no-catalog',
			icon: 'cloud-off',
			text: reachable
				? _(t`The stock list has not loaded yet. It will load in a moment.`)
				: _(
						t`The stock list has not loaded yet. Connect once so this tablet can get it.`,
					),
		})
	}
	if (catalog && stale && checkedAt !== null) {
		const hours = Math.floor((Date.now() - checkedAt) / 3_600_000)
		notices.push({
			key: 'stale',
			icon: 'clock',
			text: _(
				plural(hours, {
					one: 'The stock list is # hour old. You can still count and log waste; it updates when this tablet is connected.',
					other:
						'The stock list is # hours old. You can still count and log waste; it updates when this tablet is connected.',
				}),
			),
		})
	}
	if (catalog && !stale && stock.refreshError && reachable) {
		notices.push({
			key: 'refresh',
			icon: 'cloud-off',
			text: _(
				t`Could not update the stock list. Using the copy saved on this tablet.`,
			),
		})
	}
	if (
		stock.refreshError === 'inventory_not_enabled' ||
		stock.refreshError === 'inventory_disabled'
	) {
		notices.push({
			key: 'off',
			icon: 'alert-triangle',
			text: pauseText(stock.refreshError, i18n),
		})
	}
	const paused = syncState.paused
	if (paused && stats.waiting > 0) {
		notices.push({
			key: 'paused',
			icon: 'alert-triangle',
			text: pauseText(paused, i18n),
			action:
				needsSignIn(paused) && onSignIn ? (
					<Button onClick={onSignIn}>
						<Trans>Sign in again</Trans>
					</Button>
				) : onOpenSync ? (
					<Button onClick={onOpenSync}>
						<Trans>See what is waiting</Trans>
					</Button>
				) : undefined,
		})
	} else if (!stock.hasSession && stats.waiting > 0) {
		notices.push({
			key: 'no-session',
			icon: 'alert-triangle',
			text: pauseText('staff_session_required', i18n),
			action: onSignIn ? (
				<Button onClick={onSignIn}>
					<Trans>Sign in again</Trans>
				</Button>
			) : undefined,
		})
	} else if (syncState.error && stats.waiting > 0) {
		notices.push({
			key: 'retry',
			icon: 'cloud-off',
			text: retryText(syncState.error, i18n),
			action: (
				<Button onClick={() => void stock.sync(true)}>
					<Trans>Try now</Trans>
				</Button>
			),
		})
	}
	if (notices.length === 0) return null
	return (
		<div className={compact ? 'flex flex-col gap-2' : 'flex flex-col'}>
			{notices.map((notice) => (
				<div
					key={notice.key}
					role="status"
					className={
						compact
							? 'notice-warning flex flex-wrap items-center gap-3 rounded-(--station-panel-radius) px-4 py-3 text-sm'
							: 'notice-warning flex flex-wrap items-center gap-3 px-4 py-2 text-sm'
					}
				>
					<Icon name={notice.icon} className="size-4 shrink-0" aria-hidden />
					<p className="min-w-0 flex-1">{notice.text}</p>
					{notice.action}
				</div>
			))}
		</div>
	)
}
