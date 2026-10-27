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
import { Checkbox } from '@repo/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { useCallback, useEffect, useRef, useState } from 'react'
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
	// Dialogs hold the tab id, not a copy: the poll keeps the total, the
	// payment state and the review prompt current while a dialog is open.
	const [closingId, setClosingId] = useState<string | null>(null)
	const [voidingId, setVoidingId] = useState<string | null>(null)
	const [lockingId, setLockingId] = useState<string | null>(null)
	const [lockBusy, setLockBusy] = useState(false)
	const [releasingId, setReleasingId] = useState<string | null>(null)
	const [releaseBusy, setReleaseBusy] = useState(false)
	const find = (id: string | null) =>
		id ? (tabs.find((tab) => tab.id === id) ?? null) : null
	const closing = find(closingId)
	const voiding = find(voidingId)
	const locking = find(lockingId)
	const releasing = find(releasingId)
	const headingRef = useRef<HTMLHeadingElement>(null)
	// After an action removes the button that opened the dialog, focus lands on
	// the list heading (or the page heading once no tab is left), not on body.
	const settledFocus = useRef(false)
	const finalFocus = () => {
		if (!settledFocus.current) return true
		settledFocus.current = false
		const target =
			headingRef.current ?? document.querySelector<HTMLElement>('main h1')
		if (target && !target.hasAttribute('tabindex')) {
			target.setAttribute('tabindex', '-1')
		}
		return target ?? true
	}
	const acting = useRef(false)

	// A tab settled elsewhere (another device, the guest's payment) closes its
	// open dialog with a notice instead of failing on confirm.
	useEffect(() => {
		if (acting.current) return
		const gone = [closingId, voidingId, lockingId, releasingId].some(
			(id) => id && !tabs.some((tab) => tab.id === id),
		)
		if (!gone) return
		setClosingId(null)
		setVoidingId(null)
		setLockingId(null)
		setReleasingId(null)
		toast.info(_(msg`That tab was settled on another device or by the guest.`))
	}, [tabs, closingId, voidingId, lockingId, releasingId, _])

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

	const act = async (
		path: string,
		body: unknown,
		done: string,
		after?: (response: unknown) => Promise<void>,
	) => {
		acting.current = true
		try {
			const response = await request(path, {
				method: 'POST',
				body: JSON.stringify(body),
			})
			toast.success(done)
			await after?.(response)
			settledFocus.current = true
			await load()
			return true
		} catch (cause) {
			toast.error(
				cause instanceof OperatorRequestError
					? cause.message
					: _(msg`That did not work. Try again.`),
			)
			// The tab changed under the open dialog: show the new total.
			if (cause instanceof OperatorRequestError && cause.code === 'stale_tab') {
				await load()
			}
			return false
		} finally {
			acting.current = false
		}
	}

	/**
	 * The region unbound the session; the App (the only caller of the
	 * processors) now closes the guest's Stripe page. Ids only.
	 */
	const closeReleasedPage = async (tabId: string, response: unknown) => {
		const parsed = z
			.object({
				release: z.object({
					releasedSession: z
						.object({ sessionId: z.string(), processor: z.string() })
						.nullable(),
				}),
			})
			.safeParse(response)
		const session = parsed.success ? parsed.data.release.releasedSession : null
		if (!session || session.processor !== 'connect') return
		const closed = await fetch(`/${orgSlug}/qr/release-session`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tabId, ...session }),
		}).catch(() => null)
		if (!closed?.ok) {
			toast.warning(
				_(
					msg`The guest's payment page could not be closed. If they still pay, the tab is marked for review.`,
				),
			)
		}
	}

	const failedBanner = failed ? (
		<div
			role="alert"
			className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-sm"
		>
			<span>
				{tabs.length > 0
					? _(
							msg`Open table tabs could not be refreshed. This list may be out of date.`,
						)
					: _(msg`Open table tabs could not be loaded.`)}
			</span>
			<Button size="sm" variant="outline" onClick={() => void load()}>
				<Trans>Try again</Trans>
			</Button>
		</div>
	) : null
	if (tabs.length === 0) return failedBanner

	return (
		<section aria-labelledby="open-tabs-heading" className="space-y-3">
			<h2
				id="open-tabs-heading"
				ref={headingRef}
				tabIndex={-1}
				className="text-base font-semibold outline-none"
			>
				<Trans>Open tabs</Trans>
			</h2>
			{failedBanner}
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
								{tab.paymentStatus === 'review' ? (
									<Badge variant="destructive">
										{_(msg`Paid online, needs review`)}
									</Badge>
								) : null}
							</div>
							{tab.paymentStatus === 'review' ? (
								<p className="text-sm" role="note">
									{tab.onlineAmountCents != null
										? (() => {
												const amount = formatMoney(
													tab.onlineAmountCents,
													tab.totals.currency,
													i18n.locale,
												)
												const count = tab.reviewPaymentCount ?? 1
												return count > 1
													? _(
															msg`${count} online payments totalling ${amount} arrived that do not match this tab. Check each one in your payment dashboard before you close or void.`,
														)
													: _(
															msg`A payment of ${amount} arrived online that does not match this tab. Check it in your payment dashboard before you close or void.`,
														)
											})()
										: _(
												msg`A payment arrived online that does not match this tab. Check it in your payment dashboard before you close or void.`,
											)}
								</p>
							) : null}
							<ol className="flex flex-col gap-1 text-sm">
								{tab.rounds.map((round) => (
									<li
										key={round.id}
										className="flex items-center justify-between gap-2"
									>
										<span className="min-w-0 wrap-anywhere">
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
										onClick={() => setClosingId(tab.id)}
										disabled={tab.paymentStatus === 'pending'}
										aria-label={_(
											msg`Close at counter, tab ${number}, table ${label}`,
										)}
									>
										<Trans>Close at counter</Trans>
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => setVoidingId(tab.id)}
										disabled={tab.paymentStatus === 'pending'}
										aria-label={_(msg`Void, tab ${number}, table ${label}`)}
									>
										<Trans>Void</Trans>
									</Button>
									{!tab.lockedAt ? (
										<Button
											size="sm"
											variant="ghost"
											onClick={() => setLockingId(tab.id)}
											aria-label={_(msg`Lock, tab ${number}, table ${label}`)}
										>
											<Trans>Lock</Trans>
										</Button>
									) : null}
									{tab.paymentStatus === 'pending' ? (
										<Button
											size="sm"
											variant="ghost"
											onClick={() => setReleasingId(tab.id)}
											aria-label={_(
												msg`Stop online payment, tab ${number}, table ${label}`,
											)}
										>
											<Trans>Stop online payment</Trans>
										</Button>
									) : null}
									{tab.paymentStatus === 'pending' ? (
										<p className="text-muted-foreground w-full text-xs">
											<Trans>
												The guest is paying online. Close and void wait until
												the payment finishes, or stop the online payment if it
												is stuck.
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
				onClose={() => setClosingId(null)}
				finalFocus={finalFocus}
				onConfirm={async (tipCents) => {
					if (!closing) return
					const number = closing.tabNumber
					if (
						await act(
							`/tabs/${closing.id}/close`,
							{
								paymentMethod: 'counter',
								...(tipCents ? { tipCents } : {}),
								// The total shown in the dialog: a round that lands meanwhile
								// is refused (409 stale_tab), never marked paid unseen.
								expectedTotalCents: closing.totals.totalCents,
								...(closing.paymentStatus === 'review'
									? { acknowledgeReview: true }
									: {}),
							},
							_(msg`Tab ${number} closed`),
						)
					) {
						setClosingId(null)
					}
				}}
			/>
			<AlertDialog
				open={Boolean(locking)}
				onOpenChange={(open) => !open && setLockingId(null)}
			>
				<AlertDialogContent finalFocus={finalFocus}>
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
							disabled={lockBusy}
							onClick={() => {
								if (!locking) return
								const tab = locking
								setLockBusy(true)
								void act(
									`/tabs/${tab.id}/lock`,
									{},
									_(msg`Tab locked. Guests can no longer add to it.`),
								)
									.then((ok) => {
										if (ok) setLockingId(null)
									})
									.finally(() => setLockBusy(false))
							}}
						>
							<Trans>Lock tab</Trans>
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog
				open={Boolean(releasing)}
				onOpenChange={(open) => !open && setReleasingId(null)}
			>
				<AlertDialogContent finalFocus={finalFocus}>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Stop the online payment?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								Use this when the guest gave up on the payment page or it is
								stuck. You can then close the tab at the counter. Card pages are
								closed where the payment provider allows it; if money still
								arrives, the tab is marked for review.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep waiting</Trans>
						</AlertDialogCancel>
						<Button
							disabled={releaseBusy}
							onClick={() => {
								if (!releasing) return
								const tab = releasing
								setReleaseBusy(true)
								void act(
									`/tabs/${tab.id}/release-payment`,
									{},
									_(msg`Online payment stopped. You can close the tab now.`),
									(response) => closeReleasedPage(tab.id, response),
								)
									.then((ok) => {
										if (ok) setReleasingId(null)
									})
									.finally(() => setReleaseBusy(false))
							}}
						>
							<Trans>Stop online payment</Trans>
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<VoidTabDialog
				tab={voiding}
				onClose={() => setVoidingId(null)}
				finalFocus={finalFocus}
				onConfirm={async (reason) => {
					if (!voiding) return
					const number = voiding.tabNumber
					if (
						await act(
							`/tabs/${voiding.id}/void`,
							{
								reason,
								expectedTotalCents: voiding.totals.totalCents,
								...(voiding.paymentStatus === 'review'
									? { acknowledgeReview: true }
									: {}),
							},
							_(msg`Tab ${number} voided`),
						)
					) {
						setVoidingId(null)
					}
				}}
			/>
		</section>
	)
}

type FinalFocus = () => HTMLElement | boolean

function CloseTabDialog({
	tab,
	onClose,
	onConfirm,
	finalFocus,
}: {
	tab: QrTab | null
	onClose: () => void
	onConfirm: (tipCents: number) => Promise<void>
	finalFocus: FinalFocus
}) {
	const { _, i18n } = useLingui()
	const [tip, setTip] = useState('')
	const [busy, setBusy] = useState(false)
	const [acknowledged, setAcknowledged] = useState(false)
	useEffect(() => {
		setTip('')
		setAcknowledged(false)
	}, [tab?.id])
	const needsReview = tab?.paymentStatus === 'review'
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
			<AlertDialogContent finalFocus={finalFocus}>
				<AlertDialogHeader>
					<AlertDialogTitle>
						<Trans>Close this tab at the counter?</Trans>
					</AlertDialogTitle>
					<AlertDialogDescription>
						{needsReview ? (
							<Trans>
								An online payment arrived that does not match this tab. Closing
								does not refund it: refund or keep it in your payment dashboard,
								and take only what is still owed at the counter.
							</Trans>
						) : tab?.roundsPending ? (
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
				{needsReview ? (
					<ReviewAcknowledgement
						id="tab-close-review"
						checked={acknowledged}
						onCheckedChange={setAcknowledged}
					/>
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel>
						<Trans>Cancel</Trans>
					</AlertDialogCancel>
					<Button
						disabled={busy || (needsReview && !acknowledged)}
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
	finalFocus,
}: {
	tab: QrTab | null
	onClose: () => void
	onConfirm: (reason: string) => Promise<void>
	finalFocus: FinalFocus
}) {
	const { _ } = useLingui()
	const [reason, setReason] = useState('')
	const [busy, setBusy] = useState(false)
	const [acknowledged, setAcknowledged] = useState(false)
	useEffect(() => {
		setReason('')
		setAcknowledged(false)
	}, [tab?.id])
	const needsReview = tab?.paymentStatus === 'review'
	return (
		<AlertDialog
			open={Boolean(tab)}
			onOpenChange={(open) => !open && onClose()}
		>
			<AlertDialogContent finalFocus={finalFocus}>
				<AlertDialogHeader>
					<AlertDialogTitle>
						<Trans>Void this tab?</Trans>
					</AlertDialogTitle>
					<AlertDialogDescription>
						{needsReview ? (
							<Trans>
								An online payment arrived for this tab. Voiding does not refund
								it: refund it in your payment dashboard. Orders the kitchen has
								not finished are cancelled.
							</Trans>
						) : (
							<Trans>
								Nothing is charged. Orders the kitchen has not finished are
								cancelled.
							</Trans>
						)}
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
				{needsReview ? (
					<ReviewAcknowledgement
						id="tab-void-review"
						checked={acknowledged}
						onCheckedChange={setAcknowledged}
					/>
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel>
						<Trans>Cancel</Trans>
					</AlertDialogCancel>
					<Button
						variant="destructive"
						disabled={busy || !reason.trim() || (needsReview && !acknowledged)}
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

/** A tab paid online with a mismatch: staff confirm they checked the money. */
function ReviewAcknowledgement({
	id,
	checked,
	onCheckedChange,
}: {
	id: string
	checked: boolean
	onCheckedChange: (checked: boolean) => void
}) {
	return (
		<label
			htmlFor={id}
			className="flex min-h-11 items-start gap-2.5 text-sm md:min-h-8"
		>
			<Checkbox id={id} checked={checked} onCheckedChange={onCheckedChange} />
			<span>
				<Trans>
					I checked the online payment for this tab in the payment dashboard and
					will refund or keep it.
				</Trans>
			</span>
		</label>
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
