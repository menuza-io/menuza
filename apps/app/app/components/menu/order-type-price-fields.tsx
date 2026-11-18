import { type MessageDescriptor } from '@lingui/core'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	MENU_ORDER_TYPES,
	type MenuOrderType,
	type OrderTypePrices,
} from '@repo/common/menu-pricing'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'

export const ORDER_TYPE_MESSAGES: Record<MenuOrderType, MessageDescriptor> = {
	dine_in: msg`Dine-in price`,
	pickup: msg`Pickup price`,
	delivery: msg`Delivery price`,
}

/** Text drafts per order type; empty means "use the base price". */
export type OrderTypePriceDraft = Record<MenuOrderType, string>

export function orderTypePriceDraft(
	prices: OrderTypePrices | null | undefined,
): OrderTypePriceDraft {
	return {
		dine_in: prices?.dine_in != null ? String(prices.dine_in) : '',
		pickup: prices?.pickup != null ? String(prices.pickup) : '',
		delivery: prices?.delivery != null ? String(prices.delivery) : '',
	}
}

/** The posted value: only filled, valid fields; null when none is set. */
export function orderTypePricesFromDraft(
	draft: OrderTypePriceDraft,
): OrderTypePrices | null {
	const out: OrderTypePrices = {}
	for (const type of MENU_ORDER_TYPES) {
		const text = draft[type].trim()
		if (!text) continue
		const value = Number(text)
		if (Number.isFinite(value) && value >= 0) out[type] = value
	}
	return Object.keys(out).length > 0 ? out : null
}

/**
 * Optional dine-in, pickup and delivery prices (#412). An empty field uses the
 * base price; a location's fixed price still wins over all of them.
 */
export function OrderTypePriceFields({
	idPrefix,
	value,
	onChange,
	basePrice,
}: {
	idPrefix: string
	value: OrderTypePriceDraft
	onChange: (next: OrderTypePriceDraft) => void
	basePrice: number
}) {
	const { _ } = useLingui()
	const placeholder = basePrice ? basePrice.toFixed(2) : '0.00'
	return (
		<div className="flex flex-col gap-2">
			<div className="grid gap-3 sm:grid-cols-3">
				{MENU_ORDER_TYPES.map((type) => (
					<div key={type} className="space-y-1.5">
						<Label htmlFor={`${idPrefix}-${type}`} className="text-xs">
							{_(ORDER_TYPE_MESSAGES[type])}
						</Label>
						<Input
							id={`${idPrefix}-${type}`}
							type="number"
							step="0.01"
							min="0"
							inputMode="decimal"
							value={value[type]}
							placeholder={placeholder}
							onChange={(event) =>
								onChange({ ...value, [type]: event.target.value })
							}
						/>
					</div>
				))}
			</div>
			<p className="text-muted-foreground text-xs">
				<Trans>
					Leave a field empty to use the base price. A location's own price
					still wins.
				</Trans>
			</p>
		</div>
	)
}
