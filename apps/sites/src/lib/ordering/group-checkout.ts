import { type GroupView } from '@repo/common/group-orders'
import { getLocalizedMenuValue } from '@repo/common/menu-types'

import { type CartItem } from './types.ts'

/**
 * The host's group checkout (#170). The group page copies the group's dishes
 * into a cart of their own (the host's personal cart is left alone) and leaves a
 * note in this tab's session storage; the normal checkout then prices and pays
 * as always and sends `groupId`, `groupVersion` and the host's token with the
 * order. The region prices the group's own lines: what the browser shows here is
 * only what the host saw.
 */

export type GroupCheckoutNote = {
	groupId: string
	version: number
	token: string
}

/** A note is only good for this long: an abandoned checkout must not linger. */
export const GROUP_CHECKOUT_NOTE_TTL_MS = 30 * 60_000

const noteKey = (orgId: string) => `menuza_group_checkout_${orgId}`

export const groupCartKey = (orgId: string) => `menuza_cart_${orgId}_group`

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function readGroupCheckout(
	storage: StorageLike | null,
	orgId: string,
	now: number = Date.now(),
): GroupCheckoutNote | null {
	try {
		const raw = storage?.getItem(noteKey(orgId))
		if (!raw) return null
		const value = JSON.parse(raw) as Record<string, unknown>
		if (
			typeof value.savedAt !== 'number' ||
			now - value.savedAt > GROUP_CHECKOUT_NOTE_TTL_MS ||
			value.savedAt > now + 60_000
		) {
			storage?.removeItem(noteKey(orgId))
			return null
		}
		if (
			typeof value.groupId === 'string' &&
			typeof value.token === 'string' &&
			typeof value.version === 'number' &&
			Number.isInteger(value.version)
		) {
			return {
				groupId: value.groupId,
				version: value.version,
				token: value.token,
			}
		}
	} catch {
		// treated as no group checkout
	}
	return null
}

export function saveGroupCheckout(
	storage: StorageLike | null,
	orgId: string,
	note: GroupCheckoutNote,
	now: number = Date.now(),
) {
	try {
		storage?.setItem(noteKey(orgId), JSON.stringify({ ...note, savedAt: now }))
	} catch {
		// the checkout then reads as an ordinary one: the region refuses nothing here
	}
}

export function clearGroupCheckout(storage: StorageLike | null, orgId: string) {
	try {
		storage?.removeItem(noteKey(orgId))
	} catch {
		// nothing to clear
	}
}

/**
 * The group's dishes as cart lines, for the checkout page to show and quote.
 * Prices are what the region said when each dish was added; the region prices
 * the order again.
 */
export function cartFromGroupView(
	view: GroupView,
	locale: string,
	defaultLocale: string,
): CartItem[] {
	return view.lines.map((entry) => {
		const quantity = Math.max(1, entry.line.quantity)
		const unit = entry.amountMinor / 100 / quantity
		const local = (value: string) =>
			getLocalizedMenuValue(value, locale, defaultLocale)
		return {
			id: `group_${entry.id}`,
			itemId: entry.line.itemId,
			...(entry.line.variantId ? { variantId: entry.line.variantId } : {}),
			name: local(entry.itemName),
			basePrice: unit,
			unitPrice: unit,
			quantity,
			instructions: entry.line.instructions ?? '',
			options: [
				// The variant, as the cart echoes it: shown, never sent as a modifier.
				...entry.variantNames.map((name, index) => ({
					groupId: `variant_${index}`,
					groupName: '',
					optionId: `variant_${index}`,
					optionName: local(name),
					priceDelta: 0,
					variation: true,
				})),
				...entry.options.map((option) => ({
					groupId: option.groupId,
					groupName: local(option.groupName),
					optionId: option.optionId,
					optionName: local(option.optionName),
					priceDelta: option.priceDelta,
					...(option.half ? { half: option.half } : {}),
					quantity: option.quantity,
				})),
			],
		} as CartItem
	})
}
