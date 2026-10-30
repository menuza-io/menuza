import { msg, plural, Trans } from '@lingui/macro'
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
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
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
	loyaltyEnabled,
}: {
	orgSlug: string
	canWrite: boolean
	/** Bumped by the inbox refresh so both lists move together. */
	refreshKey: number
	/** Loyalty is on: a counter close can say the till sale earns instead. */
	loyaltyEnabled: boolean
}) {
	const { _, i18n } = useLingui()
	const request = useQrClient(orgSlug)
	const [tabs, setTabs] = useState<QrTab[]>([])
	// Closed or voided tabs that later received online money (14 days).
	const [reviewTabs, setReviewTabs] = useState<QrTab[]>([])
	const [failed, setFailed] = useState(false)
	// Dialogs hold the tab id, not a copy: the poll keeps the total, the
	// payment state and the review prompt current while a dialog is open.
	const [closingId, setClosingId] = useState<string | null>(null)
	const [voidingId, setVoidingId] = useState<string | null>(null)
	const [lockingId, setLockingId] = useState<string | null>(null)
	const [lockBusy, setLockBusy] = useState(false)
	const [releasingId, setReleasingId] = useState<string | null>(null)
	const [releaseBusy, setReleaseBusy] = useState(false)
	// Counter closes marked as rung up on a till, while loyalty is on.
	const [markedTabs, setMarkedTabs] = useState<QrTab[]>([])
	const [unmarkingId, setUnmarkingId] = useState<string | null>(null)
	const [unmarkBusy, setUnmarkBusy] = useState(false)
	const unmarking = unmarkingId
		? (markedTabs.find((tab) => tab.id === unmarkingId) ?? null)
		: null
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
	// A removed mark returns focus to its own list while marks are left.
	const unmarkFinalFocus = () => {
		const heading = document.getElementById('station-marks-heading')
		if (!settledFocus.current || !heading) return finalFocus()
		settledFocus.current = false
		return heading
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
				const list = z.object({ tabs: z.array(qrTabSchema) })
				const [open, review] = await Promise.all([
					request('/tabs?status=open', { signal }),
					request('/tabs?status=review', { signal }),
				])
				if (!signal?.aborted) {
					setTabs(list.parse(open).tabs)
					setReviewTabs(list.parse(review).tabs)
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

	// Not polled: the mark changes only when a tab is closed or the mark is
	// removed. Both reload this list when done here; Refresh picks up other
	// devices.
	const loadMarked = useCallback(
		async (signal?: AbortSignal) => {
			if (!loyaltyEnabled) {
				setMarkedTabs([])
				return
			}
			try {
				const marked = z
					.object({ tabs: z.array(qrTabSchema) })
					.parse(await request('/tabs?status=station&limit=200', { signal }))
				if (!signal?.aborted) setMarkedTabs(marked.tabs)
			} catch {
				// The open tabs report their own failure; this list keeps its last state.
			}
		},
		[request, loyaltyEnabled],
	)

	useEffect(() => {
		const controller = new AbortController()
		void loadMarked(controller.signal)
		return () => controller.abort()
	}, [loadMarked, refreshKey])

	// The mark went away (removed on another device): the dialog has nothing
	// left to do.
	useEffect(() => {
		if (unmarkingId && !markedTabs.some((tab) => tab.id === unmarkingId)) {
			setUnmarkingId(null)
		}
	}, [markedTabs, unmarkingId])

	const act = async (
		path: string,
		body: unknown,
		done: string,
		/** Returns a warning to show instead of the success message. */
		after?: (response: unknown) => Promise<string | null>,
	) => {
		acting.current = true
		try {
			const response = await request(path, {
				method: 'POST',
				body: JSON.stringify(body),
			})
			// Follow-up first (closing the guest's page), so a single message
			// tells the outcome: success, or what still needs attention.
			const warning = await after?.(response)
			if (warning) toast.warning(warning)
			else toast.success(done)
			settledFocus.current = true
			await Promise.all([load(), loadMarked()])
			return true
		} catch (cause) {
			toast.error(
				cause instanceof OperatorRequestError
					? cause.message
					: _(msg`That did not work. Try again.`),
			)
			// The tab changed under the open dialog: show it as it is now.
			if (
				cause instanceof OperatorRequestError &&
				(cause.code === 'stale_tab' || cause.code === 'station_flag_not_set')
			) {
				await Promise.all([load(), loadMarked()])
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
	const closeReleasedPage = async (
		tabId: string,
		response: unknown,
		warning: string,
	): Promise<string | null> => {
		const parsed = z
			.object({
				releasedSession: z
					.object({ sessionId: z.string(), processor: z.string() })
					.nullable()
					.optional(),
			})
			.safeParse(response)
		const session = parsed.success ? parsed.data.releasedSession : null
		if (!session || session.processor !== 'connect') return null
		const closed = await fetch(`/${orgSlug}/qr/release-session`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tabId, ...session }),
		}).catch(() => null)
		return closed?.ok ? null : warning
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
	const reviewSection =
		reviewTabs.length > 0 ? <PaymentsToCheck tabs={reviewTabs} /> : null
	const markedSection =
		markedTabs.length > 0 ? (
			<MarkedOnStation
				tabs={markedTabs}
				canWrite={canWrite}
				onUnmark={setUnmarkingId}
			/>
		) : null
	const unmarkDialog = (
		<AlertDialog
			open={Boolean(unmarking)}
			onOpenChange={(open) => !open && setUnmarkingId(null)}
		>
			<AlertDialogContent finalFocus={unmarkFinalFocus}>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{(() => {
							const number = unmarking?.tabNumber ?? ''
							const label = unmarking?.table.label ?? ''
							return _(
								msg`Remove the till mark from tab ${number} (table ${label})?`,
							)
						})()}
					</AlertDialogTitle>
					<AlertDialogDescription>
						<Trans>
							The tab then earns loyalty points like any other tab. Do this only
							if it was not rung up on a Station till, or the guest could earn
							twice.
						</Trans>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>
						<Trans>Cancel</Trans>
					</AlertDialogCancel>
					<Button
						disabled={unmarkBusy}
						onClick={() => {
							if (!unmarking) return
							const tab = unmarking
							const number = tab.tabNumber
							setUnmarkBusy(true)
							void act(
								`/tabs/${tab.id}/clear-station-flag`,
								{},
								_(
									msg`Mark removed from tab ${number}. It now earns loyalty points like any other tab.`,
								),
							)
								.then((ok) => {
									if (ok) setUnmarkingId(null)
								})
								.finally(() => setUnmarkBusy(false))
						}}
					>
						<Trans>Remove the mark</Trans>
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
	if (tabs.length === 0) {
		// The dialog stays mounted when its list empties, so it closes normally.
		return (
			<>
				{failedBanner}
				{reviewSection}
				{markedSection}
				{unmarkDialog}
			</>
		)
	}

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
									<bdi className="wrap-anywhere">{tab.guestName}</bdi>
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
												return _(
													plural(count, {
														one: `A payment of ${amount} arrived online that does not match this tab. Check it in your payment dashboard before you close or void.`,
														other: `# online payments totalling ${amount} arrived that do not match this tab. Check each one in your payment dashboard before you close or void.`,
													}),
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
											{/* Each item isolated so a Latin name in Arabic keeps its place. */}
											{new Intl.ListFormat(i18n.locale, { type: 'unit' })
												.formatToParts(
													round.lines.map(
														(line) =>
															`${line.quantity}× ${localizedName(line.itemName, i18n.locale)}`,
													),
												)
												.map((part, index) =>
													part.type === 'element' ? (
														<bdi key={index}>{part.value}</bdi>
													) : (
														part.value
													),
												)}
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
			{reviewSection}
			{markedSection}
			{unmarkDialog}

			<CloseTabDialog
				tab={closing}
				onClose={() => setClosingId(null)}
				finalFocus={finalFocus}
				loyaltyEnabled={loyaltyEnabled}
				onConfirm={async (tipCents, expectedTotalCents, rungUpOnStation) => {
					if (!closing) return
					const number = closing.tabNumber
					const tabId = closing.id
					if (
						await act(
							`/tabs/${closing.id}/close`,
							{
								paymentMethod: 'counter',
								...(tipCents ? { tipCents } : {}),
								// The total staff saw: a round that lands meanwhile is
								// refused (409 stale_tab), never marked paid unseen.
								expectedTotalCents,
								...(closing.paymentStatus === 'review'
									? { acknowledgeReview: true }
									: {}),
								// The till sale earns the loyalty points, so the tab never does.
								...(rungUpOnStation ? { rungUpOnStation: true } : {}),
							},
							_(msg`Tab ${number} closed`),
							(response) =>
								closeReleasedPage(
									tabId,
									response,
									_(
										msg`Tab ${number} closed, but the guest's online payment page could not be closed. If they still pay, it shows under online payments to check.`,
									),
								),
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
							{(() => {
								const number = locking?.tabNumber ?? ''
								const label = locking?.table.label ?? ''
								return _(msg`Lock tab ${number} (table ${label})?`)
							})()}
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
							{(() => {
								const number = releasing?.tabNumber ?? ''
								const label = releasing?.table.label ?? ''
								return _(
									msg`Stop the online payment for tab ${number} (table ${label})?`,
								)
							})()}
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
									(response) =>
										closeReleasedPage(
											tab.id,
											response,
											_(
												msg`Online payment stopped, but the guest's payment page could not be closed. If they still pay, the tab is marked for review.`,
											),
										),
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
				onConfirm={async (reason, expectedTotalCents) => {
					if (!voiding) return
					const number = voiding.tabNumber
					const tabId = voiding.id
					if (
						await act(
							`/tabs/${voiding.id}/void`,
							{
								reason,
								expectedTotalCents,
								...(voiding.paymentStatus === 'review'
									? { acknowledgeReview: true }
									: {}),
							},
							_(msg`Tab ${number} voided`),
							(response) =>
								closeReleasedPage(
									tabId,
									response,
									_(
										msg`Tab ${number} voided, but the guest's online payment page could not be closed. If they still pay, it shows under online payments to check.`,
									),
								),
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
	loyaltyEnabled,
}: {
	tab: QrTab | null
	onClose: () => void
	onConfirm: (
		tipCents: number,
		expectedTotalCents: number,
		rungUpOnStation: boolean,
	) => Promise<void>
	finalFocus: FinalFocus
	loyaltyEnabled: boolean
}) {
	const { _, i18n } = useLingui()
	const seenTotal = useSeenTotal(tab)
	const billRef = useRef<HTMLParagraphElement>(null)
	const [tip, setTip] = useState('')
	const [busy, setBusy] = useState(false)
	const [acknowledged, setAcknowledged] = useState(false)
	const [rungUpOnStation, setRungUpOnStation] = useState(false)
	useEffect(() => {
		setTip('')
		setAcknowledged(false)
		setRungUpOnStation(false)
	}, [tab?.id])
	const needsReview = tab?.paymentStatus === 'review'
	const parsedTip = parseTip(tip)
	const tipCents = parsedTip.cents
	const total = tab
		? formatMoney(seenTotal.seen + tipCents, tab.totals.currency, i18n.locale)
		: ''
	const bill = tab
		? formatMoney(seenTotal.seen, tab.totals.currency, i18n.locale)
		: ''
	const bigTip = parsedTip.valid && tipCents > seenTotal.seen && tipCents > 0
	return (
		<AlertDialog
			open={Boolean(tab)}
			onOpenChange={(open) => !open && onClose()}
		>
			<AlertDialogContent finalFocus={finalFocus}>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{(() => {
							const number = tab?.tabNumber ?? ''
							const label = tab?.table.label ?? ''
							return _(
								msg`Close tab ${number} (table ${label}) at the counter?`,
							)
						})()}
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
				<p ref={billRef} tabIndex={-1} className="text-sm outline-none">
					{_(msg`Tab total: ${bill}`)}
				</p>
				<TotalChanged
					tab={tab}
					changed={seenTotal.changed}
					onAccept={seenTotal.accept}
					focusAfter={billRef}
				/>
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
						aria-invalid={parsedTip.valid ? undefined : true}
						aria-describedby={
							parsedTip.valid ? 'tab-tip-total' : 'tab-tip-error'
						}
					/>
					{parsedTip.valid ? (
						<FieldDescription id="tab-tip-total">
							{bigTip
								? _(
										msg`The tip is more than the bill. Check it: the guest pays ${total} in total.`,
									)
								: _(msg`The guest pays ${total} in total, tip included.`)}
						</FieldDescription>
					) : (
						<FieldError id="tab-tip-error">
							{_(
								msg`Enter the tip as a plain amount, like 5 or 5.50, without thousands separators.`,
							)}
						</FieldError>
					)}
				</Field>
				{loyaltyEnabled ? (
					<label
						htmlFor="tab-close-station"
						className="flex min-h-11 items-start gap-2.5 text-sm md:min-h-8"
					>
						{/* The label also wraps the help and warning: name it by the title. */}
						<Checkbox
							id="tab-close-station"
							checked={rungUpOnStation}
							onCheckedChange={setRungUpOnStation}
							aria-labelledby="tab-close-station-title"
							aria-describedby={
								rungUpOnStation
									? 'tab-close-station-help tab-close-station-warning'
									: 'tab-close-station-help'
							}
						/>
						<span className="flex flex-col gap-0.5">
							<span id="tab-close-station-title">
								<Trans>Rung up on a Station till</Trans>
							</span>
							<span
								id="tab-close-station-help"
								className="text-muted-foreground"
							>
								<Trans>
									The till sale collects the loyalty points, so this tab does
									not.
								</Trans>
							</span>
							{rungUpOnStation ? (
								<span
									id="tab-close-station-warning"
									className="text-destructive"
								>
									<Trans>
										The guest earns no points on this tab. If this is a mistake,
										you can remove the mark on this page for the next 24 hours.
									</Trans>
								</span>
							) : null}
						</span>
					</label>
				) : null}
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
						disabled={
							busy ||
							(needsReview && !acknowledged) ||
							!parsedTip.valid ||
							seenTotal.changed
						}
						onClick={() => {
							setBusy(true)
							void onConfirm(
								tipCents,
								seenTotal.seen,
								loyaltyEnabled && rungUpOnStation,
							).finally(() => setBusy(false))
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
	onConfirm: (reason: string, expectedTotalCents: number) => Promise<void>
	finalFocus: FinalFocus
}) {
	const { _ } = useLingui()
	const seenTotal = useSeenTotal(tab)
	const reasonRef = useRef<HTMLInputElement>(null)
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
						{(() => {
							const number = tab?.tabNumber ?? ''
							const label = tab?.table.label ?? ''
							return _(msg`Void tab ${number} (table ${label})?`)
						})()}
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
				<TotalChanged
					tab={tab}
					changed={seenTotal.changed}
					onAccept={seenTotal.accept}
					focusAfter={reasonRef}
				/>
				<Field>
					<FieldLabel htmlFor="tab-void-reason">
						<Trans>Reason</Trans>
					</FieldLabel>
					<Input
						ref={reasonRef}
						id="tab-void-reason"
						value={reason}
						maxLength={200}
						required
						aria-required
						aria-describedby="tab-void-reason-help"
						onChange={(event) => setReason(event.target.value)}
						placeholder={_(msg`For example: the guest left`)}
					/>
					<FieldDescription id="tab-void-reason-help">
						<Trans>Required. Kept on the tab for your records.</Trans>
					</FieldDescription>
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
						disabled={
							busy ||
							!reason.trim() ||
							(needsReview && !acknowledged) ||
							seenTotal.changed
						}
						onClick={() => {
							setBusy(true)
							void onConfirm(reason.trim(), seenTotal.seen).finally(() =>
								setBusy(false),
							)
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
 * Closed or voided tabs that received online money afterwards (or money that
 * did not settle them), kept 14 days: staff refund or keep it in the payment
 * dashboard. Ids and amounts only; nothing here changes the tab.
 */
function PaymentsToCheck({ tabs }: { tabs: QrTab[] }) {
	const { _, i18n } = useLingui()
	return (
		<section aria-labelledby="payments-to-check-heading" className="space-y-2">
			<h3 id="payments-to-check-heading" className="text-sm font-semibold">
				<Trans>Online payments to check</Trans>
			</h3>
			<p className="text-muted-foreground text-sm">
				<Trans>
					These tabs were settled at the counter or voided, and money still
					arrived online. Refund it or keep it in your payment dashboard.
				</Trans>
			</p>
			<ul className="divide-border divide-y rounded-lg border text-sm">
				{tabs.map((tab) => {
					const label = tab.table.label
					const number = tab.tabNumber
					const count = tab.reviewPaymentCount ?? 1
					const amount = formatMoney(
						tab.onlineAmountCents ?? 0,
						tab.totals.currency,
						i18n.locale,
					)
					return (
						<li
							key={tab.id}
							className="flex flex-wrap items-baseline justify-between gap-2 p-3"
						>
							<span>
								<bdi>{_(msg`Table ${label}`)}</bdi>
								<span className="text-muted-foreground ms-2 tabular-nums">
									{_(msg`Tab ${number}`)}
								</span>
							</span>
							<span className="tabular-nums">
								{_(
									plural(count, {
										one: `One online payment of ${amount}`,
										other: `# online payments totalling ${amount}`,
									}),
								)}
							</span>
						</li>
					)
				})}
			</ul>
		</section>
	)
}

/**
 * Tabs closed at the counter in the last 24 hours as rung up on a Station
 * till: the till sale earns their points, so they do not. A mark set by
 * mistake is removed here and the tab earns. Collapsed, because where every
 * tab goes through a till the list is long and rarely needed.
 */
function MarkedOnStation({
	tabs,
	canWrite,
	onUnmark,
}: {
	tabs: QrTab[]
	canWrite: boolean
	onUnmark: (tabId: string) => void
}) {
	const { _, i18n } = useLingui()
	const [open, setOpen] = useState(false)
	const count = tabs.length
	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			render={<section aria-labelledby="station-marks-heading" />}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3
					id="station-marks-heading"
					tabIndex={-1}
					className="text-sm font-semibold outline-none"
				>
					{_(
						plural(count, {
							one: '# tab rung up on a Station till in the last 24 hours',
							other: '# tabs rung up on a Station till in the last 24 hours',
						}),
					)}
				</h3>
				<CollapsibleTrigger
					render={<Button type="button" variant="outline" size="sm" />}
					aria-label={
						open
							? _(msg`Hide the tabs rung up on a Station till`)
							: _(msg`Show the tabs rung up on a Station till`)
					}
				>
					{open ? <Trans>Hide</Trans> : <Trans>Show</Trans>}
					<Icon name={open ? 'chevron-up' : 'chevron-down'} />
				</CollapsibleTrigger>
			</div>
			<CollapsibleContent>
				<div className="space-y-2 pt-2">
					<p className="text-muted-foreground text-sm">
						<Trans>
							These tabs earn no loyalty points, because the till sale does. If
							one was not rung up on a till, remove its mark so it earns.
						</Trans>
					</p>
					<ul className="divide-border divide-y rounded-lg border text-sm">
						{tabs.map((tab) => {
							const label = tab.table.label
							const number = tab.tabNumber
							return (
								<li
									key={tab.id}
									className="flex flex-wrap items-center justify-between gap-2 p-3"
								>
									<span>
										<bdi>{_(msg`Table ${label}`)}</bdi>
										<span className="text-muted-foreground ms-2 tabular-nums">
											{_(msg`Tab ${number}`)}
										</span>
										<span className="text-muted-foreground ms-2">
											{relativeTime(tab.closedAt, i18n.locale)}
										</span>
									</span>
									<span className="flex items-center gap-3">
										<span className="tabular-nums">
											<bdi>
												{formatMoney(
													tab.totals.totalCents,
													tab.totals.currency,
													i18n.locale,
												)}
											</bdi>
										</span>
										{canWrite ? (
											<Button
												size="sm"
												variant="outline"
												onClick={() => onUnmark(tab.id)}
												aria-label={_(
													msg`Remove the mark, tab ${number}, table ${label}`,
												)}
											>
												<Trans>Remove the mark</Trans>
											</Button>
										) : null}
									</span>
								</li>
							)
						})}
					</ul>
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}

/**
 * The total staff saw when the dialog opened. The poll may add a round while
 * the dialog is open: that change is announced and must be accepted before
 * the tab can be closed or voided, and the seen total is what the region
 * checks (409 `stale_tab` otherwise).
 */
function useSeenTotal(tab: QrTab | null) {
	const [seen, setSeen] = useState<number | null>(null)
	useEffect(() => {
		setSeen(tab ? tab.totals.totalCents : null)
		// Only a different tab resets it; a new total must be accepted.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tab?.id])
	const live = tab?.totals.totalCents ?? null
	const changed = seen !== null && live !== null && live !== seen
	return {
		seen: seen ?? live ?? 0,
		changed,
		accept: () => setSeen(live),
	}
}

/**
 * The status region stays mounted (empty until the total changes) so the
 * change is announced; accepting moves focus to the element that now shows
 * the new total, since the button itself goes away.
 */
function TotalChanged({
	tab,
	changed,
	onAccept,
	focusAfter,
}: {
	tab: QrTab | null
	changed: boolean
	onAccept: () => void
	focusAfter: RefObject<HTMLElement | null>
}) {
	const { _, i18n } = useLingui()
	const amount = tab
		? formatMoney(tab.totals.totalCents, tab.totals.currency, i18n.locale)
		: ''
	const text = changed
		? _(msg`The tab total changed: it is now ${amount}.`)
		: ''
	return (
		<>
			{/* Always mounted, so the change is announced; out of the layout. */}
			<p role="status" className="sr-only">
				{text}
			</p>
			{changed ? (
				<div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
					<span aria-hidden="true">{text}</span>
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							onAccept()
							requestAnimationFrame(() => focusAfter.current?.focus())
						}}
					>
						<Trans>Use the new total</Trans>
					</Button>
				</div>
			) : null}
		</>
	)
}

/**
 * A typed tip in major units: Arabic-Indic digits and a comma decimal ("٥",
 * "5,50") are accepted; anything unreadable counts as no tip.
 */
export function parseTipCents(raw: string): number {
	return parseTip(raw).cents
}

/**
 * Strict reading: digits with at most one decimal mark and two decimals.
 * Anything else ("1,000", "5 000", "abc") is invalid rather than silently a
 * different amount.
 */
export function parseTip(raw: string): { cents: number; valid: boolean } {
	const text = raw
		.trim()
		.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
		.replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
		.replace(/[\u066b,]/g, '.')
	if (text === '') return { cents: 0, valid: true }
	if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return { cents: 0, valid: false }
	return { cents: Math.round(Number.parseFloat(text) * 100), valid: true }
}
