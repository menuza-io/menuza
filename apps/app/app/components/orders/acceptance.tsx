import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	ORDER_REJECT_REASONS,
	type OrderRejectReason,
} from '@repo/common/restaurant-orders'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { useEffect, useState } from 'react'
import { SelectField } from '#app/components/staff/controls.tsx'
import { formatClock, secondsUntil } from '#app/utils/orders/acceptance.ts'
import { CANCEL_REASON_LABELS } from './refund-labels.ts'

/** Seconds left until the deadline, ticking every second; null without one. */
export function useSecondsLeft(deadline: string | null | undefined) {
	const [now, setNow] = useState(() => Date.now())
	const active = secondsUntil(deadline, 0) !== null
	useEffect(() => {
		if (!active) return
		setNow(Date.now())
		const timer = window.setInterval(() => setNow(Date.now()), 1000)
		return () => window.clearInterval(timer)
	}, [active, deadline])
	return secondsUntil(deadline, now)
}

/** "Accept within 3:12", or "Time is up" once the deadline has passed. */
export function AcceptanceCountdown({
	deadline,
	className,
}: {
	deadline: string | null | undefined
	className?: string
}) {
	const { _ } = useLingui()
	const left = useSecondsLeft(deadline)
	if (left === null) return null
	const clock = formatClock(left)
	return (
		<span
			className={className}
			data-testid="acceptance-countdown"
			data-expired={left <= 0 ? 'true' : 'false'}
		>
			{left <= 0 ? _(msg`Time is up`) : _(msg`Accept within ${clock}`)}
		</span>
	)
}

/** Asks why an order is rejected; the guest sees only two of the reasons. */
export function RejectOrderDialog({
	open,
	onOpenChange,
	orderNumber,
	refundsGuest,
	busy,
	onConfirm,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	orderNumber: string
	/** A paid online order: the guest is refunded in full. */
	refundsGuest: boolean
	busy: boolean
	onConfirm: (reason: OrderRejectReason) => void
}) {
	const { _ } = useLingui()
	const [reason, setReason] = useState('')
	useEffect(() => {
		if (open) setReason('')
	}, [open])
	const options = ORDER_REJECT_REASONS.map((value) => ({
		value,
		label: _(CANCEL_REASON_LABELS[value]!),
	}))
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{_(msg`Reject order ${orderNumber}?`)}
					</AlertDialogTitle>
					<AlertDialogDescription>
						<Trans>
							The order is cancelled right away and nothing is cooked.
						</Trans>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<div className="flex flex-col gap-3">
					<SelectField
						label={<Trans>Why are you rejecting it?</Trans>}
						hint={_(
							msg`The guest sees only "out of stock" or "kitchen closed". Other reasons stay with you.`,
						)}
						id="order-reject-reason"
						testId="order-reject-reason"
						options={options}
						value={reason}
						onValueChange={setReason}
						placeholder={_(msg`Choose a reason`)}
					/>
					{refundsGuest ? (
						<p
							className="text-muted-foreground text-sm"
							data-testid="order-reject-refund-note"
						>
							<Trans>The guest is refunded in full.</Trans>
						</p>
					) : null}
				</div>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={busy}>
						<Trans>Keep waiting</Trans>
					</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={busy || !reason}
						onClick={() => {
							if (!reason) return
							onOpenChange(false)
							onConfirm(reason as OrderRejectReason)
						}}
					>
						<Trans>Reject order</Trans>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
