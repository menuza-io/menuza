import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type PosOrder } from '~/lib/db.ts'
import { formatPickupAt } from '~/lib/pickup.ts'

export function PhonePickupDetails({
	order,
	printed = false,
}: {
	order: Pick<
		PosOrder,
		| 'orderSource'
		| 'customerName'
		| 'customerPhone'
		| 'pickupAt'
		| 'pickupTimeZone'
	>
	printed?: boolean
}) {
	const { i18n } = useLingui()
	if (order.orderSource !== 'phone') return null
	const pickup =
		order.pickupAt == null
			? null
			: formatPickupAt(order.pickupAt, i18n.locale, order.pickupTimeZone)
	const phone = order.customerPhone
	return (
		<div className="space-y-1 text-sm">
			<p className="font-semibold">
				<Trans>Phone · Pickup</Trans>
			</p>
			<p className="break-words">
				{order.customerName}
				{phone ? (
					<>
						{' '}
						· <bdi dir="ltr">{printed ? `•••• ${phone.slice(-4)}` : phone}</bdi>
					</>
				) : null}
			</p>
			<p>
				{pickup ? <Trans>Pickup: {pickup}</Trans> : <Trans>Pickup ASAP</Trans>}
			</p>
		</div>
	)
}
