import { useLingui } from '@lingui/react/macro'

export function formatCents(cents: number, currency: string): string {
	try {
		return new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency,
		}).format(cents / 100)
	} catch {
		return `${(cents / 100).toFixed(2)} ${currency}`
	}
}

/** The guest's words for an order's status. */
export function useOrderStatusLabel() {
	const { t } = useLingui()
	return (status: string): string => {
		switch (status) {
			case 'pending_acceptance':
				return t`Waiting for the restaurant`
			case 'accepted':
				return t`Accepted`
			case 'preparing':
				return t`Preparing`
			case 'ready':
				return t`Ready`
			case 'completed':
				return t`Completed`
			case 'cancelled':
				return t`Cancelled`
			case 'expired':
				return t`Expired`
			case 'payment_review':
				return t`Payment under review`
			default:
				return status
		}
	}
}
