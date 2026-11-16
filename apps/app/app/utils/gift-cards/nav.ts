import {
	GIFT_CARD_PERMISSIONS,
	type GiftCardFeatures,
	type GiftCardPermission,
} from '@repo/common/gift-cards'

/** What the sidebar and the gift card screens show to a member. */
export type GiftCardNavAccess = {
	visible: boolean
	/** Adjust, void, review, import, card stock. */
	canManage: boolean
	/** Charge a card from the App. */
	canCharge: boolean
	online: boolean
	pos: boolean
}

export const HIDDEN_GIFT_CARD_NAV: GiftCardNavAccess = {
	visible: false,
	canManage: false,
	canCharge: false,
	online: false,
	pos: false,
}

export function computeGiftCardNavAccess(
	features: GiftCardFeatures,
	grants: readonly GiftCardPermission[],
): GiftCardNavAccess {
	if (!features.enabled) return HIDDEN_GIFT_CARD_NAV
	const held = new Set<string>(grants)
	if (!held.has(GIFT_CARD_PERMISSIONS.READ_GIFT_CARD)) return HIDDEN_GIFT_CARD_NAV
	return {
		visible: true,
		canManage: held.has(GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD),
		canCharge: held.has(GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD_CHARGE),
		online: features.online,
		pos: features.pos,
	}
}
