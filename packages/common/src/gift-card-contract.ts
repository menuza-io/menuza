/**
 * The public gift-card wire contract shared by tenant-api, Sites, Station and
 * the customer app: strict request bodies (unknown fields are refused, nothing
 * is echoed back on a validation error) and the responses clients validate.
 * Browser-direct: the organization comes from the browser `Origin` plus the
 * site's slug or host, never from a client-sent organization id.
 */
import { z } from 'zod'
import {
	GIFT_CARD_DESIGN_KEYS,
	GIFT_CARD_ERROR_CODES,
	GIFT_CARD_STATUSES,
	giftCardDesignKeySchema,
} from './gift-cards.ts'

const binding = {
	slug: z.string().min(1).max(100).optional(),
	host: z.string().min(1).max(255).optional(),
}

const emailSchema = z.string().trim().toLowerCase().email().max(254)
const nameSchema = z.string().trim().min(1).max(100)
const minorSchema = z.number().int().min(1).max(10_000_000)

export const giftCardCodeInputSchema = z.string().trim().min(8).max(64)

export const giftCardPurchaseRequestSchema = z.strictObject({
	...binding,
	amountMinor: minorSchema,
	designKey: giftCardDesignKeySchema.optional(),
	/** Who it is for; omitted when `sendToSelf`. */
	recipient: z
		.strictObject({ name: nameSchema.optional(), email: emailSchema })
		.nullable()
		.optional(),
	sendToSelf: z.boolean().default(false),
	/** The "From" line on the card. */
	senderName: nameSchema.optional(),
	message: z.string().trim().max(500).optional(),
	/** When to deliver (ms since epoch); omitted means now. */
	deliverAt: z.number().int().positive().optional(),
	purchaser: z.strictObject({ name: nameSchema.optional(), email: emailSchema }),
	locationId: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/)
		.optional(),
	locale: z.string().min(2).max(12).optional(),
	/** A random id the browser keeps, hashed in the region for purchase limits. */
	deviceId: z.string().min(8).max(100).optional(),
	turnstileToken: z.string().max(4096).optional(),
})
export type GiftCardPurchaseRequest = z.infer<typeof giftCardPurchaseRequestSchema>

export const giftCardPurchaseResponseSchema = z.object({
	cardId: z.string(),
	orderRef: z.string(),
	paymentToken: z.string(),
	amountMinor: z.number().int(),
	feeMinor: z.number().int(),
	totalMinor: z.number().int(),
	currency: z.string(),
	holdExpiresAt: z.number().int(),
})
export type GiftCardPurchaseResponse = z.infer<typeof giftCardPurchaseResponseSchema>

export const giftCardBalanceRequestSchema = z.strictObject({
	...binding,
	code: giftCardCodeInputSchema,
	turnstileToken: z.string().max(4096).optional(),
})

export const giftCardGuestViewSchema = z.object({
	id: z.string(),
	last4: z.string().max(8),
	status: z.enum(GIFT_CARD_STATUSES),
	balanceMinor: z.number().int().min(0),
	currency: z.string(),
	expiresAt: z.number().int().nullable(),
	note: z.enum(['being_prepared']).nullable(),
})
export type GiftCardGuestViewDto = z.infer<typeof giftCardGuestViewSchema>

export const giftCardHistoryEntrySchema = z.object({
	id: z.string(),
	kind: z.string(),
	amountMinor: z.number().int(),
	channel: z.string(),
	at: z.number().int(),
})

export const savedGiftCardSchema = giftCardGuestViewSchema.extend({
	savedAt: z.number().int().nullable(),
	recent: z.array(giftCardHistoryEntrySchema),
})
export type SavedGiftCardDto = z.infer<typeof savedGiftCardSchema>

export const giftCardMineResponseSchema = z.object({
	cards: z.array(savedGiftCardSchema),
})

export const giftCardClaimRequestSchema = z.strictObject({
	...binding,
	code: giftCardCodeInputSchema,
})

export const giftCardClaimResponseSchema = z.object({
	card: giftCardGuestViewSchema,
	alreadyMine: z.boolean(),
})

export const giftCardShowTokenRequestSchema = z.strictObject({ ...binding })
export const giftCardShowTokenResponseSchema = z.object({
	token: z.string(),
	expiresAt: z.number().int(),
})

/** What the purchase page needs; `enabled: false` hides the page. */
export const giftCardOptionsSchema = z.object({
	enabled: z.boolean(),
	currency: z.string().nullable(),
	presetsMinor: z.array(z.number().int()),
	minAmountMinor: z.number().int(),
	maxAmountMinor: z.number().int(),
	allowCustomAmount: z.boolean(),
	designs: z.array(
		z.object({
			key: z.enum(GIFT_CARD_DESIGN_KEYS),
			imageUrl: z.string().nullable(),
		}),
	),
	defaultDesign: z.enum(GIFT_CARD_DESIGN_KEYS),
	locations: z.array(
		z.object({ id: z.string(), name: z.string().nullable(), timeZone: z.string().nullable() }),
	),
	maxDeliverAheadDays: z.number().int(),
})
export type GiftCardOptions = z.infer<typeof giftCardOptionsSchema>

/** A card applied to a checkout: on the quote and the order request. */
export const giftCardCheckoutInputSchema = z.strictObject({
	/** The typed code, or `savedCardId` for a card in the guest's account. */
	code: giftCardCodeInputSchema.optional(),
	savedCardId: z.string().min(1).max(64).optional(),
	/** The amount the page showed; a different one is `gift_card_changed`. */
	expectedAmountMinor: z.number().int().min(0).max(10_000_000),
})
export type GiftCardCheckoutInput = z.infer<typeof giftCardCheckoutInputSchema>

export const giftCardCheckoutQuoteSchema = z.object({
	cardId: z.string(),
	last4: z.string(),
	appliedMinor: z.number().int().min(0),
	balanceMinor: z.number().int().min(0),
	remainingBalanceMinor: z.number().int().min(0),
	/** What is still to pay after the card. */
	dueMinor: z.number().int().min(0),
})
export type GiftCardCheckoutQuote = z.infer<typeof giftCardCheckoutQuoteSchema>

export const giftCardErrorBodySchema = z.object({
	error: z.enum(GIFT_CARD_ERROR_CODES).or(z.string()),
	code: z.string().optional(),
	balanceMinor: z.number().int().optional(),
	retryAfterSeconds: z.number().optional(),
})

// --- Station (device secret + staff session; online only) -----------------

export const posGiftCardLookupSchema = z.strictObject({
	/** A typed or scanned code, or a guest's one-use show token. */
	code: z.string().trim().min(8).max(200),
})

export const posGiftCardSellSchema = z.strictObject({
	/** A printed card's code to activate; omit for a card with no plastic. */
	code: giftCardCodeInputSchema.optional(),
	amountMinor: minorSchema,
	paymentMethod: z.enum(['cash', 'card', 'other']),
	clientRequestId: z.string().min(8).max(100),
})

export const posGiftCardTopUpSchema = z.strictObject({
	code: z.string().trim().min(8).max(200),
	amountMinor: minorSchema,
	clientRequestId: z.string().min(8).max(100),
})

export const posGiftCardRedeemSchema = z.strictObject({
	code: z.string().trim().min(8).max(200),
	amountMinor: minorSchema,
	/** The till's sale id the tender will be recorded on. */
	saleId: z.string().min(8).max(100),
	clientRequestId: z.string().min(8).max(100),
})

export const posGiftCardRefundSchema = z.strictObject({
	/** The redemption reference the till kept (`reference` of the redeem answer). */
	reference: z.string().min(8).max(100),
	amountMinor: minorSchema,
	clientRequestId: z.string().min(8).max(100),
})
