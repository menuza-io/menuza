import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Field, FieldDescription, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { OrderStatusLabel } from '#app/components/orders/order-status.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { useQrClient } from '#app/hooks/use-qr-client.ts'
import {
	formatMoney,
	localizedName,
	relativeTime,
} from '#app/utils/orders/order-model.ts'
import { qrTabSchema, type QrTab } from '#app/utils/qr/qr-model.ts'

/**
 * Open table tabs above the order list: running total and rounds per table,
 * with counter close and void. Rounds keep their own status buttons below.
 * Polls with the inbox (15 s) while the page is visible.
 */
export function OpenTabs({
	orgSlug,
	canWrite,
	refreshKey,
}: {
	orgSlug: string
	canWrite: boolean
	/** Bumped by the inbox refresh so both lists move together. */
	refreshKey: number
}) {
	const { _, i18n } = useLingui()
	const request = useQrClient(orgSlug)
	const [tabs, setTabs] = useState<QrTab[]>([])
	const [failed, setFailed] = useState(false)
	const [closing, setClosing] = useState<QrTab | null>(null)
	const [voiding, setVoiding] = useState<QrTab | null>(null)
	const [locking, setLocking] = useState<QrTab | null>(null)

	const load = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const body = z
					.object({ tabs: z.array(qrTabSchema) })
					.parse(await request('/tabs?status=open', { signal }))
				if (!signal?.aborted) {
					setTabs(body.tabs)
					setFailed(false)
				}
			} catch {
				if (!signal?.aborted) setFailed(true)
			}
		},
		[request],
	)

	useEffect(() => {
		const controller = new AbortController()
		void load(controller.signal)
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible') void load(controller.signal)
		}, 15000)
		return () => {
			controller.abort()
			window.clearInterval(timer)
		}
	}, [load, refreshKey])

	const act = async (path: string, body: unknown, done: string) => {
		try {
			await request(path, { method: 'POST', body: JSON.stringify(body) })
			toast.success(done)
			await load()
			return true
		} catch (cause) {
			toast.error(
				cause instanceof OperatorRequestError
					? cause.message
					: _(msg`That did not work. Try again.`),
			)
			return false
		}
	}

	if (failed) {
		return (
			<div
				role="alert"
				className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-sm"
			>
				<span>{_(msg`Open table tabs could not be loaded.`)}</span>
				<Button size="sm" variant="outline" onClick={() => void load()}>
					<Trans>Try again</Trans>
				</Button>
			</div>
		)
	}
	if (tabs.length === 0) return null

	return (
		<section aria-labelledby="open-tabs-heading" className="space-y-3">
			<h2 id="open-tabs-heading" className="text-base font-semibold">
				<Trans>Open tabs</Trans>
			</h2>
			<ul className="grid gap-3 sm:grid-cols-2" data-testid="open-tabs">
				{tabs.map((tab) => {
					const label = tab.table.label
					const number = tab.tabNumber
					return (
						<li
							key={tab.id}
							className="flex flex-col gap-3 rounded-lg border p-4"
							data-testid="open-tab"
						>
							<div className="flex items-baseline justify-between gap-3">
								<span className="font-medium">
									<bdi>{_(msg`Table ${label}`)}</bdi>
									<span className="text-muted-foreground ms-2 text-sm font-normal tabular-nums">
										{_(msg`Tab ${number}`)}
									</span>
								</span>
								<span className="font-medium tabular-nums">
									<bdi>
										{formatMoney(
											tab.totals.totalCents,
											tab.totals.currency,
											i18n.locale,
										)}
									</bdi>
								</span>
							</div>
							<div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
								<span>{relativeTime(tab.openedAt, i18n.locale)}</span>
								{tab.guestName ? (
									<span className="wrap-anywhere">· {tab.guestName}</span>
								) : null}
								{tab.lockedAt ? (
									<Badge variant="warning">{_(msg`Locked`)}</Badge>
								) : null}
								{tab.paymentStatus === 'pending' ? (
									<Badge variant="warning">{_(msg`Paying online`)}</Badge>
								) : null}
							</div>
							<ol className="flex flex-col gap-1 text-sm">
								{tab.rounds.map((round) => (
									<li
										key={round.id}
										className="flex items-center justify-between gap-2"
									>
										<span className="min-w-0 truncate">
											{round.lines
												.map(
													(line) =>
														`${line.quantity}× ${localizedName(line.itemName, i18n.locale)}`,
												)
												.join(', ')}
										</span>
										<OrderStatusLabel status={round.status} />
									</li>
								))}
							</ol>
							{canWrite ? (
								<div className="flex flex-wrap gap-2">
									<Button
										size="sm"
										onClick={() => setClosing(tab)}
										disabled={tab.paymentStatus === 'pending'}
										aria-label={_(
											msg`Close tab ${number} for table ${label} at the counter`,
										)}
									>
										<Trans>Close at counter</Trans>
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => setVoiding(tab)}
										disabled={tab.paymentStatus === 'pending'}
										aria-label={_(msg`Void tab ${number} for table ${label}`)}
									>
										<Trans>Void</Trans>
									</Button>
									{!tab.lockedAt ? (
										<Button
											size="sm"
											variant="ghost"
											onClick={() => setLocking(tab)}
											aria-label={_(msg`Lock tab ${number} for table ${label}`)}
										>
											<Trans>Lock</Trans>
										</Button>
									) : null}
									{tab.paymentStatus === 'pending' ? (
										<p className="text-muted-foreground w-full text-xs">
											<Trans>
												The guest is paying online. Close and void wait until
												the payment finishes.
											</Trans>
										</p>
									) : null}
								</div>
							) : null}
						</li>
					)
				})}
			</ul>

			<CloseTabDialog
				tab={closing}
				onClose={() => setClosing(null)}
				onConfirm={async (tipCents) => {
					if (!closing) return
					const number = closing.tabNumber
					if (
						await act(
							`/tabs/${closing.id}/close`,
							{ paymentMethod: 'counter', ...(tipCents ? { tipCents } : {}) },
							_(msg`Tab ${number} closed`),
						)
					) {
						setClosing(null)
					}
				}}
			/>
			<AlertDialog
				open={Boolean(locking)}
				onOpenChange={(open) => !open && setLocking(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Lock this tab?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								No phone can add to it or pay it any more, and scanning the
								table code is refused too. Close or void it at the counter to
								finish.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<Button
							onClick={() => {
								if (!locking) return
								const tab = locking
								void act(
									`/tabs/${tab.id}/lock`,
									{},
									_(msg`Tab locked. Guests can no longer add to it.`),
								).then(() => setLocking(null))
							}}
						>
							<Trans>Lock tab</Trans>
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<VoidTabDialog
				tab={voiding}
				onClose={() => setVoiding(null)}
				onConfirm={async (reason) => {
					if (!voiding) return
					const number = voiding.tabNumber
					if (
						await act(
							`/tabs/${voiding.id}/void`,
							{ reason },
							_(msg`Tab ${number} voided`),
						)
					) {
						setVoiding(null)
					}
				}}
			/>
		</section>
	)
}

function CloseTabDialog({
	tab,
	onClose,
	onConfirm,
}: {
	tab: QrTab | null
	onClose: () => void
	onConfirm: (tipCents: number) => Promise<void>
}) {
	const { _, i18n } = useLingui()
	const [tip, setTip] = useState('')
	const [busy, setBusy] = useState(false)
	useEffect(() => setTip(''), [tab?.id])
	const tipCents = parseTipCents(tip)
	const total = tab
		? formatMoney(
				tab.totals.totalCents + tipCents,
				tab.totals.currency,
				i18n.locale,
			)
		: ''
	return (
		<AlertDialog
			open={Boolean(tab)}
			onOpenChange={(open) => !open && onClose()}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						<Trans>Close this tab at the counter?</Trans>
					</AlertDialogTitle>
					<AlertDialogDescription>
						{tab?.roundsPending ? (
							<Trans>
								The kitchen is still working on part of this tab. Close it only
								when the guest has paid.
							</Trans>
						) : (
							<Trans>Close it once the guest has paid the total below.</Trans>
						)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<Field>
					<FieldLabel htmlFor="tab-tip">
						{(() => {
							const currency = tab?.totals.currency ?? ''
							return _(msg`Tip in ${currency} (optional)`)
						})()}
					</FieldLabel>
					<Input
						id="tab-tip"
						inputMode="decimal"
						value={tip}
						onChange={(event) => setTip(event.target.value)}
						className="w-32"
					/>
					<FieldDescription>
						{(() => {
							const amount = total
							return _(msg`The guest pays ${amount} in total, tip included.`)
						})()}
					</FieldDescription>
				</Field>
				<AlertDialogFooter>
					<AlertDialogCancel>
						<Trans>Cancel</Trans>
					</AlertDialogCancel>
					<Button
						disabled={busy}
						onClick={() => {
							setBusy(true)
							void onConfirm(tipCents).finally(() => setBusy(false))
						}}
					>
						<Trans>Close tab</Trans>
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

function VoidTabDialog({
	tab,
	onClose,
	onConfirm,
}: {
	tab: QrTab | null
	onClose: () => void
	onConfirm: (reason: string) => Promise<void>
}) {
	const { _ } = useLingui()
	const [reason, setReason] = useState('')
	const [busy, setBusy] = useState(false)
	useEffect(() => setReason(''), [tab?.id])
	return (
		<AlertDialog
			open={Boolean(tab)}
			onOpenChange={(open) => !open && onClose()}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						<Trans>Void this tab?</Trans>
					</AlertDialogTitle>
					<AlertDialogDescription>
						<Trans>
							Nothing is charged. Orders the kitchen has not finished are
							cancelled.
						</Trans>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<Field>
					<FieldLabel htmlFor="tab-void-reason">
						<Trans>Reason</Trans>
					</FieldLabel>
					<Input
						id="tab-void-reason"
						value={reason}
						maxLength={200}
						onChange={(event) => setReason(event.target.value)}
						placeholder={_(msg`For example: the guest left`)}
					/>
				</Field>
				<AlertDialogFooter>
					<AlertDialogCancel>
						<Trans>Cancel</Trans>
					</AlertDialogCancel>
					<Button
						variant="destructive"
						disabled={busy || !reason.trim()}
						onClick={() => {
							setBusy(true)
							void onConfirm(reason.trim()).finally(() => setBusy(false))
						}}
					>
						<Trans>Void tab</Trans>
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

/**
 * A typed tip in major units: Arabic-Indic digits and a comma decimal ("٥",
 * "5,50") are accepted; anything unreadable counts as no tip.
 */
export function parseTipCents(raw: string): number {
	const digits = raw
		.trim()
		.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
		.replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
		.replace(/[\u066b,]/g, '.')
		.replace(/[^\d.]/g, '')
	const value = Number.parseFloat(digits)
	return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0
}
