import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type OrderRejectReason } from '@repo/common/restaurant-orders'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import {
	decideOrder,
	decisionErrorMessage,
	isAlreadyDecided,
	rejectNotice,
} from '#app/utils/orders/acceptance.ts'
import { formatMoney, type Order } from '#app/utils/orders/order-model.ts'
import { ordersHref } from '#app/utils/orders/orders-link.ts'
import {
	chimeReady,
	clearSoundChoice,
	playChime,
	readSoundChoice,
	unlockChime,
	writeSoundChoice,
} from '#app/utils/orders/waiting-chime.ts'
import { AcceptanceCountdown, RejectOrderDialog } from './acceptance.tsx'

const CHIME_EVERY_MS = 6000
/** How long "Order accepted" stays once nothing else waits. */
const NOTICE_MS = 10000

/**
 * Orders that wait for a person to accept them. Shows nothing while none
 * waits. A repeating chime plays while any order waits, once the browser has
 * been allowed to make sound; the "Sound" button turns it on and off again.
 * After a decision the answer is announced here and focus moves to the lane
 * heading, because the row that had focus is gone.
 */
export function WaitingLane({
	orgSlug,
	orders,
	canWrite,
	request,
	onChanged,
}: {
	orgSlug: string
	orders: Order[]
	canWrite: boolean
	request: Parameters<typeof decideOrder>[0]
	/** Reload the list after a decision (or a stale answer). */
	onChanged: () => void
}) {
	const { _, i18n } = useLingui()
	const [soundOn, setSoundOn] = useState(false)
	const [busyId, setBusyId] = useState<string | null>(null)
	const [rejecting, setRejecting] = useState<Order | null>(null)
	const [message, setMessage] = useState<string | null>(null)
	const headingRef = useRef<HTMLHeadingElement>(null)
	const waiting = orders.length > 0

	useEffect(() => {
		if (readSoundChoice() && chimeReady()) setSoundOn(true)
	}, [])

	// With nothing left to accept, the lane stays just long enough to say so.
	useEffect(() => {
		if (waiting || !message) return
		const timer = window.setTimeout(() => setMessage(null), NOTICE_MS)
		return () => window.clearTimeout(timer)
	}, [waiting, message])

	useEffect(() => {
		if (!waiting || !soundOn) return
		playChime()
		const timer = window.setInterval(playChime, CHIME_EVERY_MS)
		return () => window.clearInterval(timer)
	}, [waiting, soundOn])

	if (!waiting && !message) return null

	const decide = async (
		order: Order,
		decision:
			{ kind: 'accept' } | { kind: 'reject'; reason: OrderRejectReason },
	) => {
		if (busyId) return
		setBusyId(order.id)
		setMessage(null)
		try {
			const response = await decideOrder(request, order.id, decision)
			setMessage(
				decision.kind === 'reject'
					? rejectNotice(response, _)
					: _(msg`Order accepted.`),
			)
		} catch (error) {
			setMessage(decisionErrorMessage(error, _))
			if (!isAlreadyDecided(error)) {
				setBusyId(null)
				return
			}
		}
		setBusyId(null)
		// The decided row disappears with the next list: do not leave focus on it.
		headingRef.current?.focus()
		onChanged()
	}

	return (
		<section
			className="border-warning/50 bg-warning/5 rounded-lg border"
			aria-labelledby="waiting-lane-title"
			data-testid="waiting-lane"
		>
			<div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-2">
				<h2
					id="waiting-lane-title"
					ref={headingRef}
					tabIndex={-1}
					className="flex items-center gap-2 rounded-sm text-sm font-semibold outline-none focus-visible:ring-2"
				>
					<Trans>Waiting for you</Trans>
					<Badge variant="outline" data-testid="waiting-count">
						{orders.length}
					</Badge>
				</h2>
				<Button
					type="button"
					variant="outline"
					size="sm"
					aria-pressed={soundOn}
					data-testid="waiting-sound-button"
					onClick={() => {
						if (soundOn) {
							clearSoundChoice()
							setSoundOn(false)
							return
						}
						unlockChime()
						writeSoundChoice()
						setSoundOn(true)
					}}
				>
					<Icon name={soundOn ? 'volume-2' : 'volume-x'} />
					{soundOn ? <Trans>Sound on</Trans> : <Trans>Sound off</Trans>}
				</Button>
			</div>
			<p
				role="status"
				className="text-muted-foreground px-4 pb-2 text-sm empty:hidden"
				data-testid="waiting-message"
			>
				{message}
			</p>
			<ul className="divide-border divide-y">
				{orders.map((order) => {
					const href = ordersHref(orgSlug, { orderId: order.id })
					const disabled = busyId !== null
					return (
						<li
							key={order.id}
							className="flex flex-wrap items-center justify-between gap-3 p-4"
							data-testid="waiting-row"
						>
							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="flex items-baseline gap-3">
									<Link
										to={href}
										className="font-medium tabular-nums underline-offset-4 hover:underline"
									>
										<bdi dir="ltr">{order.number}</bdi>
									</Link>
									<span className="text-sm tabular-nums">
										<bdi>
											{formatMoney(
												order.totalCents,
												order.currency,
												i18n.locale,
											)}
										</bdi>
									</span>
								</span>
								<AcceptanceCountdown
									deadline={order.acceptanceDeadlineAt}
									className="text-warning text-xs tabular-nums"
								/>
							</div>
							{canWrite ? (
								<div className="flex items-center gap-2">
									<Button
										type="button"
										variant="outline"
										disabled={disabled}
										data-testid="waiting-reject"
										onClick={() => setRejecting(order)}
									>
										<Trans>Reject</Trans>
									</Button>
									<Button
										type="button"
										disabled={disabled}
										data-testid="waiting-accept"
										onClick={() => void decide(order, { kind: 'accept' })}
									>
										<Trans>Accept</Trans>
									</Button>
								</div>
							) : null}
						</li>
					)
				})}
			</ul>
			{rejecting ? (
				<RejectOrderDialog
					open
					onOpenChange={(open) => {
						if (!open) setRejecting(null)
					}}
					orderNumber={rejecting.number}
					refundsGuest={
						rejecting.paymentStatus === 'paid' &&
						rejecting.paymentMethod === 'online'
					}
					busy={busyId !== null}
					onConfirm={(reason) => {
						const target = rejecting
						void decide(target, { kind: 'reject', reason })
					}}
				/>
			) : null}
		</section>
	)
}
