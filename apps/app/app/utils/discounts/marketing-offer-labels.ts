import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'

/** Passed as a value: Lingui reads literal braces as a placeholder. */
const tag = '{{couponCode}}'

export type MarketingOfferError =
	| 'invalid'
	| 'not_allowed'
	| 'discount_unavailable'
	| 'code_unavailable'
	| 'tag_missing'
	| 'offer_missing'

/** What the operator reads when a message's coupon is refused. */
export const MARKETING_OFFER_ERROR_MESSAGES: Record<
	MarketingOfferError,
	MessageDescriptor
> = {
	invalid: msg`The coupon settings are not valid.`,
	not_allowed: msg`You cannot attach coupons. Coupons need the Discounts feature and permission to view discounts.`,
	discount_unavailable: msg`The coupon's discount is no longer active or no longer takes codes. Choose another one.`,
	code_unavailable: msg`That code no longer belongs to the discount. Choose another code.`,
	tag_missing: msg`Add ${tag} to the message so customers see their code.`,
	offer_missing: msg`The message uses ${tag}. Choose a coupon, or remove the tag.`,
}
