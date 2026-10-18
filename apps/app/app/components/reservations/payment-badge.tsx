import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { paymentBadge } from '#app/utils/reservations/payments-view.ts'

/**
 * The one payment signal on a reservation row or sheet header: deposit paid,
 * card on file, fee due or charged, refund pending, disputed. Nothing renders
 * for a booking without a payment (`none`). The same mapping feeds the host
 * stand rows and the detail sheet, so they always agree.
 */
export function PaymentBadge({
	paymentStatus,
	experience = false,
	className,
}: {
	paymentStatus: string | null | undefined
	experience?: boolean
	className?: string
}) {
	const { _ } = useLingui()
	const info = paymentBadge(paymentStatus, { experience })
	if (!info) return null
	return (
		<Badge
			variant={info.variant}
			className={className}
			data-testid="payment-badge"
			data-payment-status={paymentStatus ?? undefined}
		>
			{_(info.label)}
		</Badge>
	)
}
