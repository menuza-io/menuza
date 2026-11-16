import { z } from 'zod'

/**
 * Primitives shared by the generic email blocks (`email-blocks.ts`) and a
 * business vertical's blocks (`email-blocks-restaurant.ts`). They live in their
 * own file so the vertical can import them without a cycle through the
 * registry that imports the vertical.
 */

export const EMAIL_BLOCK_ALIGNMENTS = ['left', 'center', 'right'] as const
export type EmailBlockAlignment = (typeof EMAIL_BLOCK_ALIGNMENTS)[number]

export const emailBlockIdSchema = z
	.string()
	.min(1)
	.max(60)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

export const emailAlignmentSchema = z
	.enum(EMAIL_BLOCK_ALIGNMENTS)
	.default('left')

export const emailUrlSchema = z
	.string()
	.max(2_000)
	.refine(
		(value) => !value.trim() || /^https?:\/\//i.test(value.trim()),
		'URL must use HTTP or HTTPS',
	)

/** Reading direction of a whole email, from the organization's site language. */
export type EmailDirection = 'ltr' | 'rtl'

/**
 * What a render knows beyond the block list. It is resolved by the caller at
 * design time (never stored in the blocks), so a block stays a small config and
 * the renderer stays free of I/O.
 */
export type EmailRenderContext = {
	direction?: EmailDirection
	/** The email's language (`en`, `ar`, …): prices, dates and fixed labels. */
	locale?: string
	/** The organization's own website origin: the only host an Order link may use. */
	siteOrigin?: string | null
	/** A Cloudflare image-transform host; when empty, original photo URLs are used. */
	imageTransformBase?: string | null
	/**
	 * The words of the coupon the message carries, built by the App from the
	 * discount (`coupon-copy.ts`). Null when the message has no coupon.
	 */
	coupon?: EmailCouponCopy | null
}

export type EmailCouponCopy = {
	headline: string
	terms: string
	/** The label of the button that opens the menu with the code applied. */
	buttonLabel: string
}
