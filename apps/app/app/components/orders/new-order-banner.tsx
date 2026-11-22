import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Link } from 'react-router'
import { alertText } from '#app/hooks/use-new-order-alerts.ts'
import { type OrderAlertItem } from '#app/utils/orders/new-order-alerts.ts'
import { ordersHref } from '#app/utils/orders/orders-link.ts'

/**
 * The banner of new orders (#265): "New order W-0042", pickup or delivery, the
 * time wanted and the total, with "Large order" when it is one. Each stays until
 * its order is opened, accepted or dismissed. Only an order number, a type, a
 * time and a total: no guest.
 */
export function NewOrderBanner({
	orgSlug,
	items,
	timeZoneOf,
	onOpen,
}: {
	orgSlug: string
	items: readonly OrderAlertItem[]
	timeZoneOf: (orderId: string) => string | null
	/** The order was opened or the banner dismissed. */
	onOpen: (orderId: string) => void
}) {
	const { _, i18n } = useLingui()
	if (items.length === 0) return null
	return (
		<ul
			className="space-y-2"
			role="region"
			aria-label={_(msg`New orders`)}
			data-testid="new-order-banner"
		>
			{items.map((item) => {
				const text = alertText(item, i18n.locale, timeZoneOf(item.orderId))
				return (
					<li
						key={item.orderId}
						role="status"
						className="border-primary/40 bg-primary/5 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
						data-testid="new-order-alert"
					>
						<div className="flex min-w-0 items-start gap-3">
							<Icon name="bell" className="mt-0.5 size-4 shrink-0" />
							<div className="min-w-0">
								<p className="text-sm font-semibold wrap-anywhere">
									<bdi>{text.title}</bdi>
								</p>
								<p className="text-muted-foreground text-sm wrap-anywhere">
									<bdi>{text.body}</bdi>
								</p>
							</div>
						</div>
						<div className="flex items-center gap-2">
							<Button
								size="sm"
								render={
									<Link to={ordersHref(orgSlug, { orderId: item.orderId })} />
								}
								onClick={() => onOpen(item.orderId)}
							>
								<Trans>Open</Trans>
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => onOpen(item.orderId)}
								aria-label={_(msg`Dismiss`)}
							>
								<Icon name="x" className="size-4" />
							</Button>
						</div>
					</li>
				)
			})}
		</ul>
	)
}
