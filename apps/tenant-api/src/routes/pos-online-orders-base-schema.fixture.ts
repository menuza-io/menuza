import { z } from 'zod'

/**
 * A frozen copy of Station's Orders wire schemas as they were on origin/main
 * before manual acceptance (#107) and provider refunds (#80): the strict
 * schemas an older Station build (a cached PWA) still parses the feed and an
 * order with. Do not edit it to follow the live schema; the contract test
 * (`pos-online-orders.test.ts`, "older Station") checks that a default
 * answer still parses with it.
 */
const versionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().min(1).max(100)

export const baseOrderSummarySchema = z.strictObject({
	id,
	number: z.string().max(40),
	version: versionSchema,
	status: z.enum(['accepted', 'preparing', 'ready', 'completed', 'cancelled']),
	fulfillment: z.enum(['pickup', 'delivery', 'dine_in']),
	channel: z.enum(['web', 'qr']),
	tableLabel: z.string().max(60).nullable(),
	guestName: z.string().max(200),
	createdAt: z.number().int(),
	dueAt: z.number().int().nullable(),
	paymentMethod: z.enum(['online', 'handoff']),
	paymentStatus: z.string().max(40),
	onTab: z.boolean(),
	currency: z.string().length(3),
	totalCents: z.number().int(),
	refundedCents: z.number().int(),
	itemCount: z.number().int().nonnegative(),
	openedAt: z.number().int().nullable(),
	completedAt: z.number().int().nullable(),
	cancelledAt: z.number().int().nullable(),
})

const basePhonePickupSchema = z.strictObject({
	id,
	number: z.string().max(40),
	guestName: z.string().max(200).nullable(),
	pickupAt: z.number().int().nullable(),
	status: z.enum(['open', 'paid']),
	currency: z.string().length(3),
	totalCents: z.number().int(),
})

const baseGrantsSchema = z.strictObject({
	view: z.boolean(),
	manage: z.boolean(),
	contact: z.boolean(),
	cancel: z.boolean(),
	refund: z.boolean(),
})

export const baseOrdersFeedSchema = z.strictObject({
	orders: z.array(baseOrderSummarySchema),
	phonePickups: z.array(basePhonePickupSchema),
	grants: baseGrantsSchema,
	serverNow: z.number().int(),
	truncated: z.boolean(),
})

const menuText = z.string().max(4000)
const baseLineSchema = z.strictObject({
	name: menuText,
	variantNames: z.array(menuText),
	quantity: z.number().int(),
	totalCents: z.number().int(),
	instructions: z.string().max(400).nullable(),
	options: z.array(
		z.strictObject({
			name: menuText,
			quantity: z.number().int(),
			half: z.enum(['whole', 'left', 'right']).nullable(),
		}),
	),
})

export const baseOrderDetailSchema = z.strictObject({
	order: baseOrderSummarySchema.extend({
		lines: z.array(baseLineSchema),
		phoneMasked: z.string().max(40),
		hasEmail: z.boolean(),
		delivery: z
			.strictObject({
				address: z.string().max(400),
				city: z.string().max(200).nullable(),
				unit: z.string().max(100).nullable(),
				postalCode: z.string().max(40).nullable(),
				notes: z.string().max(600).nullable(),
			})
			.nullable(),
		subtotalCents: z.number().int(),
		taxCents: z.number().int(),
		deliveryFeeCents: z.number().int(),
		tipCents: z.number().int(),
		discountCents: z.number().int(),
		loyaltyDiscountCents: z.number().int(),
		paidAt: z.number().int().nullable(),
		refundableCents: z.number().int().nonnegative(),
		refunds: z.array(
			z.strictObject({
				amountCents: z.number().int(),
				note: z.string().max(400),
				at: z.number().int(),
			}),
		),
		history: z.array(
			z.strictObject({
				action: z.string().max(40),
				staffName: z.string().max(200).nullable(),
				reason: z.string().max(40).nullable(),
				amountCents: z.number().int().nullable(),
				at: z.number().int(),
			}),
		),
	}),
	grants: baseGrantsSchema,
	serverNow: z.number().int(),
})
