import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo } from 'react'
import {
	failureText,
	needsSignIn,
	pauseText,
	retryText,
	WASTE_REASON_LABELS,
} from './messages.ts'
import { formatAmount, unitLabel } from './model.ts'
import {
	canRetry,
	discardAllFailed,
	discardRow,
	retryFailed,
	stockRows,
} from './queue.ts'
import { type StockState } from './useStock.ts'
import { type StockRow } from '~/lib/db.ts'
import { Badge, Button, Modal } from '~/ui/primitives.tsx'

/**
 * What is waiting on this tablet and what the office refused, in plain
 * words. A refusal stays here until a person clears it ("Sent after the count
 * closed: 3 entries"); one that can be tried again says so.
 */
export function SyncSheet({
	stock,
	open,
	onClose,
	onSignIn,
}: {
	stock: StockState
	open: boolean
	onClose: () => void
	onSignIn: () => void
}) {
	const { _, i18n } = useLingui()
	const rows = useLiveQuery(() => stockRows(stock.origin), [stock.origin], [])
	const items = useMemo(
		() => new Map(stock.catalog?.items.map((item) => [item.id, item]) ?? []),
		[stock.catalog],
	)
	const waiting = rows.filter((row) => row.status !== 'failed')
	const failed = rows.filter((row) => row.status === 'failed')
	const closed = failed.filter((row) => row.failure === 'count_closed')
	const others = failed.filter((row) => row.failure !== 'count_closed')
	const { paused, error } = stock.syncState

	const describe = (row: StockRow): string => {
		switch (row.kind) {
			case 'count_start':
				return _(t`Start a count`)
			case 'count_send':
				return _(t`Send the count for review`)
			case 'waste_undo':
				return _(t`Undo waste`)
			case 'delivery_photo':
				return _(t`Invoice photo`)
			case 'delivery': {
				const count = row.payload.lines.length
				return _(
					plural(count, {
						one: 'Delivery of # item',
						other: 'Delivery of # items',
					}),
				)
			}
			case 'count_entry': {
				const item = items.get(row.payload.entry.itemId)
				const name = item?.name ?? row.payload.entry.itemId
				const amount = row.payload.entry.amount
				if (amount === null) return _(t`${name}: cleared`)
				const unit = unitLabel(
					row.payload.entry.unit,
					item?.units ?? [],
					i18n.locale,
					row.payload.entry.amount ?? undefined,
				)
				const text = formatAmount(amount, i18n.locale)
				return _(t`${name}: ${text} ${unit}`)
			}
			case 'waste': {
				const item = items.get(row.payload.entry.itemId)
				const name = item?.name ?? row.payload.entry.itemId
				const unit = unitLabel(
					row.payload.entry.unit,
					item?.units ?? [],
					i18n.locale,
					row.payload.entry.amount ?? undefined,
				)
				const text = formatAmount(row.payload.entry.amount, i18n.locale)
				const reason = _(WASTE_REASON_LABELS[row.payload.entry.reason])
				return _(t`Waste: ${name}, ${text} ${unit}, ${reason}`)
			}
		}
	}

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={_(t`Waiting to send`)}
			size="lg"
			footer={
				<div className="flex flex-col gap-2 pb-3 sm:flex-row-reverse">
					<Button
						variant="primary"
						size="lg"
						disabled={!stock.reachable || waiting.length === 0}
						onClick={() => void stock.sync(true)}
					>
						<Icon name="refresh-cw" className="size-5" />
						<Trans>Try now</Trans>
					</Button>
					<Button size="lg" onClick={onClose}>
						<Trans>Close</Trans>
					</Button>
				</div>
			}
		>
			<div className="flex flex-col gap-5 p-4 sm:p-5">
				{paused && waiting.length > 0 ? (
					<div
						role="status"
						className="notice-warning flex flex-wrap items-center gap-3 rounded-(--station-panel-radius) px-4 py-3 text-sm"
					>
						<p className="min-w-0 flex-1">{pauseText(paused, i18n)}</p>
						{needsSignIn(paused) ? (
							<Button onClick={onSignIn}>
								<Trans>Sign in again</Trans>
							</Button>
						) : null}
					</div>
				) : error && waiting.length > 0 ? (
					<p
						role="status"
						className="notice-warning rounded-(--station-panel-radius) px-4 py-3 text-sm"
					>
						{retryText(error, i18n)}
					</p>
				) : null}
				<section className="flex flex-col gap-2">
					<h3 className="text-base font-semibold">
						<Trans>Waiting to send</Trans>
					</h3>
					{waiting.length === 0 ? (
						<p className="text-muted-foreground">
							<Trans>Everything has been sent.</Trans>
						</p>
					) : (
						<>
							<p className="text-muted-foreground text-sm">
								{_(
									plural(waiting.length, {
										one: '# thing is saved on this tablet and will be sent when it can.',
										other:
											'# things are saved on this tablet and will be sent when it can.',
									}),
								)}
							</p>
							<ul className="flex flex-col gap-1">
								{waiting.slice(0, 12).map((row) => (
									<li
										key={row.id}
										className="border-border flex items-center gap-2 rounded-(--station-control-radius) border px-3 py-2 text-sm"
									>
										<Icon
											name={
												row.status === 'syncing' ? 'refresh-cw' : 'hard-drive'
											}
											className="text-muted-foreground size-4 shrink-0"
											aria-hidden
										/>
										<span className="min-w-0 flex-1 break-words">
											{describe(row)}
										</span>
										{row.failure ? (
											<Badge tone="warning">{retryOrPause(row.failure)}</Badge>
										) : null}
									</li>
								))}
							</ul>
							{waiting.length > 12 ? (
								<p className="text-muted-foreground text-sm">
									{_(
										plural(waiting.length - 12, {
											one: 'and # more',
											other: 'and # more',
										}),
									)}
								</p>
							) : null}
						</>
					)}
				</section>
				{closed.length > 0 ? (
					<section className="flex flex-col gap-2">
						<h3 className="text-base font-semibold">
							{_(
								plural(closed.length, {
									one: 'Sent after the count closed: # entry',
									other: 'Sent after the count closed: # entries',
								}),
							)}
						</h3>
						<p className="text-muted-foreground text-sm">
							<Trans>
								The count was approved or cancelled before these reached the
								office. A manager can see them in the Menuza app.
							</Trans>
						</p>
						<div>
							<Button
								onClick={() =>
									void Promise.all(closed.map((row) => discardRow(row.id)))
								}
							>
								<Trans>Clear these</Trans>
							</Button>
						</div>
					</section>
				) : null}
				{others.length > 0 ? (
					<section className="flex flex-col gap-2">
						<h3 className="text-base font-semibold">
							<Trans>Needs attention</Trans>
						</h3>
						<ul className="flex flex-col gap-2">
							{others.map((row) => (
								<li
									key={row.id}
									className="border-destructive/40 flex flex-col gap-2 rounded-(--station-panel-radius) border p-3"
								>
									<p className="font-medium break-words">{describe(row)}</p>
									<p className="text-muted-foreground text-sm">
										{failureText(row.failure, i18n)}
									</p>
									<div className="flex flex-wrap gap-2">
										{canRetry(row.failure) ? (
											<Button onClick={() => void retryFailed(row.id)}>
												<Trans>Try again</Trans>
											</Button>
										) : null}
										<Button
											variant="ghost"
											onClick={() => void discardRow(row.id)}
										>
											<Trans>Remove</Trans>
										</Button>
									</div>
								</li>
							))}
						</ul>
						{others.length > 1 ? (
							<div>
								<Button
									variant="ghost"
									onClick={() => void discardAllFailed(stock.origin)}
								>
									<Trans>Remove all</Trans>
								</Button>
							</div>
						) : null}
					</section>
				) : null}
			</div>
		</Modal>
	)

	function retryOrPause(code: string): string {
		return paused === code ? _(t`On hold`) : _(t`Will retry`)
	}
}
