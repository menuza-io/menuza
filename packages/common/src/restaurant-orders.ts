import { z } from 'zod'
import { DAYS_OF_WEEK } from './location-types.ts'
import {
	isLocationOpenForOrdering,
	localDateAndTimeToUtc,
	type LocationOrderingAvailability,
} from './location-availability.ts'
import { generatePickupSlots, getDropDisplayStatus } from './menu-types.ts'

/**
 * Regional restaurant ordering: shared, PII-free contracts and the pure
 * server-side repricing + validation engine.
 *
 * The browser never sends prices. The regional tenant-api lazy-fetches fresh
 * non-PII catalog context from the App (`GET /resources/order-context`) and
 * re-derives every cent from menu/drop data using this module. Customer PII
 * (contact, delivery address) is only ever handled by the regional tenant-api.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESTAURANT_TURNSTILE_ACTION = 'place-order'

/** Durable order lifecycle states. */
export const RESTAURANT_ORDER_STATUS_VALUES = [
	'accepted',
	'preparing',
	'ready',
	'completed',
	'cancelled',
	'expired',
	'payment_review',
] as const
export type RestaurantOrderStatus =
	(typeof RESTAURANT_ORDER_STATUS_VALUES)[number]

/** Statuses that consume capacity. cancelled / expired / payment_review release it. */
export const RESTAURANT_ACTIVE_ORDER_STATUSES = [
	'accepted',
	'preparing',
	'ready',
	'completed',
] as const

export const RESTAURANT_PAYMENT_STATUS_VALUES = [
	'unpaid',
	'pending',
	'paid',
	'failed',
	'expired',
	'review',
] as const
export type RestaurantPaymentStatus =
	(typeof RESTAURANT_PAYMENT_STATUS_VALUES)[number]

export const RESTAURANT_MAX_LINES = 50
export const RESTAURANT_MAX_LINE_QUANTITY = 50
export const RESTAURANT_MAX_TOTAL_QUANTITY = 200
export const RESTAURANT_MAX_OPTIONS_PER_LINE = 50
export const RESTAURANT_MAX_INSTRUCTIONS_LENGTH = 280

export const RESTAURANT_TIP_MIN_PERCENT = 0
export const RESTAURANT_TIP_MAX_PERCENT = 30

/** Checkout hold for online orders when the catalog carries no drop hold. */
export const RESTAURANT_ONLINE_HOLD_MINUTES = 10
export const RESTAURANT_MIN_HOLD_MINUTES = 1
export const RESTAURANT_MAX_HOLD_MINUTES = 120

/** Nested modifier groups walk at most this many fixpoint passes (cycle guard). */
const MAX_MODIFIER_FIXPOINT_PASSES = 8

const HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/
const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Catalog prices are stored in major currency units; orders use integer cents. */
export function dollarsToCents(value: number): number {
	return Math.round(value * 100)
}

function clampInt(
	value: number,
	min: number,
	max: number,
	fallback: number,
): number {
	if (!Number.isFinite(value)) return fallback
	const rounded = Math.round(value)
	if (rounded < min || rounded > max) return fallback
	return rounded
}

// ---------------------------------------------------------------------------
// Error / result types
// ---------------------------------------------------------------------------

export type RestaurantOrderErrorCode =
	| 'invalid_request'
	| 'location_not_found'
	| 'drop_not_found'
	| 'drop_closed'
	| 'pickup_required'
	| 'pickup_not_supported'
	| 'invalid_pickup_window'
	| 'invalid_pickup_slot'
	| 'lead_time'
	| 'ordering_closed'
	| 'pickup_disabled'
	| 'delivery_disabled'
	| 'delivery_unavailable'
	| 'delivery_coverage_unverified'
	| 'minimum_order'
	| 'delivery_address_required'
	| 'delivery_not_allowed'
	| 'tips_disabled'
	| 'unknown_item'
	| 'item_unavailable'
	| 'unknown_variant'
	| 'variant_required'
	| 'variant_unavailable'
	| 'unknown_option'
	| 'option_unavailable'
	| 'unknown_modifier_group'
	| 'duplicate_option'
	| 'invalid_half'
	| 'invalid_quantity'
	| 'invalid_combination'
	| 'required_modifier'
	| 'modifier_limit'
	| 'option_quantity_limit'
	| 'instructions_not_allowed'
	| 'per_order_limit'
	| 'total_quantity_limit'

export type RestaurantOrderError = {
	status: 400 | 403 | 404 | 422
	code: RestaurantOrderErrorCode
	message: string
}

export type PriceRestaurantOrderResult =
	| { ok: true; result: PricedRestaurantOrder }
	| { ok: false; error: RestaurantOrderError }

// ---------------------------------------------------------------------------
// Browser → regional API request schema (contract: docs/restaurant-ordering-contract.md)
// ---------------------------------------------------------------------------

const phoneSchema = z
	.string()
	.trim()
	.transform((value) => value.replace(/[\s\-().]/g, ''))
	.refine((value) => /^\+?\d{7,20}$/.test(value), {
		message: 'Enter a valid phone number',
	})

export const restaurantOrderOptionSelectionSchema = z.strictObject({
	groupId: z.string().min(1).max(100),
	optionId: z.string().min(1).max(100),
	half: z.enum(['whole', 'left', 'right']).optional(),
	quantity: z
		.number()
		.int()
		.min(1)
		.max(RESTAURANT_MAX_LINE_QUANTITY)
		.optional(),
})

export const restaurantOrderLineSchema = z.strictObject({
	itemId: z.string().min(1).max(100),
	variantId: z.string().min(1).max(100).optional(),
	quantity: z.number().int().min(1).max(RESTAURANT_MAX_LINE_QUANTITY),
	instructions: z
		.string()
		.trim()
		.max(RESTAURANT_MAX_INSTRUCTIONS_LENGTH)
		.optional(),
	options: z
		.array(restaurantOrderOptionSelectionSchema)
		.max(RESTAURANT_MAX_OPTIONS_PER_LINE)
		.default([]),
})

export const restaurantOrderRequestSchema = z
	.strictObject({
		slug: z.string().trim().min(1).max(100).optional(),
		host: z.string().trim().min(1).max(253).optional(),
		idempotencyKey: z
			.string()
			.regex(UUID_REGEX, 'idempotencyKey must be a UUID'),
		locale: z.string().trim().min(2).max(10).default('en'),
		locationId: z.string().min(1).max(100),
		dropSlug: z.string().trim().min(1).max(120).optional(),
		pickup: z
			.strictObject({
				windowId: z.string().min(1).max(100),
				time: z.string().regex(HH_MM_REGEX, 'Pickup time must be HH:MM'),
			})
			.optional(),
		fulfillment: z.enum(['pickup', 'delivery']),
		paymentMethod: z.enum(['handoff', 'online']),
		contact: z.strictObject({
			name: z.string().trim().min(1).max(120),
			phone: phoneSchema,
			email: z.string().trim().email().max(254).optional(),
		}),
		delivery: z
			.strictObject({
				address: z.string().trim().min(5).max(200),
				city: z.string().trim().min(1).max(100),
				unit: z.string().trim().max(50).optional(),
				notes: z.string().trim().max(200).optional(),
			})
			.optional(),
		tipPercent: z
			.number()
			.int()
			.min(RESTAURANT_TIP_MIN_PERCENT)
			.max(RESTAURANT_TIP_MAX_PERCENT)
			.default(0),
		lines: z.array(restaurantOrderLineSchema).min(1).max(RESTAURANT_MAX_LINES),
		turnstileToken: z.string().min(1).max(2048).optional(),
	})
	.superRefine((value, context) => {
		if (value.fulfillment === 'delivery' && !value.delivery) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['delivery'],
				message: 'A delivery address is required',
			})
		}
		if (value.fulfillment !== 'delivery' && value.delivery) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['delivery'],
				message: 'Delivery details are not valid for pickup orders',
			})
		}
		if (value.dropSlug && !value.pickup) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['pickup'],
				message: 'Choose a pickup time',
			})
		}
		if (!value.dropSlug && value.pickup) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['pickup'],
				message: 'Pickup windows are only available for drops',
			})
		}
		const totalQuantity = value.lines.reduce(
			(sum, line) => sum + line.quantity,
			0,
		)
		if (totalQuantity > RESTAURANT_MAX_TOTAL_QUANTITY) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['lines'],
				message: 'This order is too large',
			})
		}
	})

export type RestaurantOrderRequest = z.infer<
	typeof restaurantOrderRequestSchema
>
export type RestaurantOrderLineRequest = z.infer<
	typeof restaurantOrderLineSchema
>

// ---------------------------------------------------------------------------
// App → regional internal payload schemas (docs/restaurant-ordering-contract.md)
// Authenticated with Bearer INTERNAL_COMMAND_TOKEN; unknown properties are
// rejected so no extra fields ever ride along.
// ---------------------------------------------------------------------------

export const orderQuoteRequestSchema = z.strictObject({
	orgId: z.string().min(1).max(100),
	orderId: z.string().min(1).max(100),
	paymentToken: z.string().min(16).max(128),
})

export const orderPaymentSessionRequestSchema = z.strictObject({
	orgId: z.string().min(1).max(100),
	orderId: z.string().min(1).max(100),
	sessionId: z.string().min(8).max(200),
	processor: z.enum(['connect', 'checkout']),
})

export const orderPaymentStatusRequestSchema = z.strictObject({
	orgId: z.string().min(1).max(100),
	orderId: z.string().min(1).max(100),
	sessionId: z.string().min(8).max(200),
	processor: z.enum(['connect', 'checkout']),
	status: z.enum(['paid', 'failed', 'expired']),
	amountCents: z.number().int().min(0),
	currency: z.string().length(3),
})

/**
 * Operator lifecycle writes (PATCH /operator/orders/:id). The contract only
 * allows forward service states plus cancel; `expired` and `payment_review`
 * are system-owned and can never be set directly.
 */
export const operatorOrderPatchSchema = z.strictObject({
	status: z.enum(['accepted', 'preparing', 'ready', 'completed', 'cancelled']),
	markPaid: z.boolean().optional(),
})

export type OperatorOrderPatch = z.infer<typeof operatorOrderPatchSchema>

/**
 * Canonical, PII-scrubbing-free fingerprint of the order semantics. The same
 * checkout attempt retried with the same idempotency key produces the same
 * hash; any semantic change produces a different one (409 on replay).
 * Routing/display-only fields (slug, host, locale, turnstile token) are
 * deliberately excluded so a retry is not poisoned by presentation changes.
 */
export function canonicalOrderRequest(request: RestaurantOrderRequest): string {
	return JSON.stringify({
		locationId: request.locationId,
		dropSlug: request.dropSlug ?? null,
		pickup: request.pickup
			? { windowId: request.pickup.windowId, time: request.pickup.time }
			: null,
		fulfillment: request.fulfillment,
		paymentMethod: request.paymentMethod,
		tipPercent: request.tipPercent,
		contact: {
			name: request.contact.name,
			phone: request.contact.phone,
			email: request.contact.email ?? null,
		},
		delivery: request.delivery
			? {
					address: request.delivery.address,
					city: request.delivery.city,
					unit: request.delivery.unit ?? null,
					notes: request.delivery.notes ?? null,
				}
			: null,
		lines: request.lines.map((line) => ({
			itemId: line.itemId,
			variantId: line.variantId ?? null,
			quantity: line.quantity,
			instructions: line.instructions ?? null,
			options: line.options.map((option) => ({
				groupId: option.groupId,
				optionId: option.optionId,
				half: option.half ?? null,
				quantity: option.quantity ?? null,
			})),
		})),
	})
}

// ---------------------------------------------------------------------------
// App → regional catalog context schemas (GET /resources/order-context)
// Mirrors the App serializers (`apps/app/app/utils/menu/public-serializers.server.ts`,
// `resources+/sites.menu.ts`, `resources+/sites.drop.ts`). Passthrough so new
// public fields do not break ordering; the engine relies only on these fields.
// ---------------------------------------------------------------------------

const availabilityStatusSchema = z.string()

const locationOverrideSchema = z
	.object({
		entityType: z.string(),
		entityId: z.string(),
		isEnabled: z.boolean().nullable().optional(),
		price: z.number().nullable().optional(),
		availabilityStatus: z.string().nullable().optional(),
	})
	.passthrough()

export type LocationOverride = z.infer<typeof locationOverrideSchema>

export type PublicMenuOptionContext = {
	id: string
	displayName: string
	price: number
	priceWhole?: number | null
	priceLeft?: number | null
	priceRight?: number | null
	minSelections?: number | null
	maxSelections?: number | null
	applySalesTax?: boolean
	availabilityStatus: string
	nestedModifierGroupIds?: string[]
	nestedModifierGroups?: PublicModifierGroupContext[]
	[key: string]: unknown
}

export type PublicModifierGroupContext = {
	id: string
	name: string
	selectionType: 'single' | 'multiple' | 'quantity' | 'pizza'
	minSelections?: number
	maxSelections?: number | null
	availabilityStatus: string
	options?: PublicMenuOptionContext[]
	[key: string]: unknown
}

const publicMenuOptionContextSchema: z.ZodType<PublicMenuOptionContext> =
	z.lazy(() =>
		z
			.object({
				id: z.string().min(1),
				displayName: z.string(),
				price: z.number().finite().min(0),
				priceWhole: z.number().finite().min(0).nullable().optional(),
				priceLeft: z.number().finite().min(0).nullable().optional(),
				priceRight: z.number().finite().min(0).nullable().optional(),
				minSelections: z.number().int().min(0).nullable().optional(),
				maxSelections: z.number().int().min(1).nullable().optional(),
				applySalesTax: z.boolean().optional(),
				availabilityStatus: availabilityStatusSchema,
				nestedModifierGroupIds: z.array(z.string()).optional(),
				nestedModifierGroups: z
					.array(publicModifierGroupContextSchema)
					.optional(),
			})
			.passthrough(),
	)

const publicModifierGroupContextSchema: z.ZodType<PublicModifierGroupContext> =
	z.lazy(() =>
		z
			.object({
				id: z.string().min(1),
				name: z.string(),
				selectionType: z.enum(['single', 'multiple', 'quantity', 'pizza']),
				minSelections: z.number().int().min(0).optional(),
				maxSelections: z.number().int().min(1).nullable().optional(),
				availabilityStatus: availabilityStatusSchema,
				options: z.array(publicMenuOptionContextSchema).optional(),
			})
			.passthrough(),
	)

export type PublicMenuItemContext = {
	id: string
	displayName: string
	price: number
	availabilityStatus: string
	variations?: {
		groups?: Array<{
			id: string
			name: string
			values?: Array<{ id: string; name: string }>
		}>
		variants?: Array<{
			id: string
			valueIds?: string[]
			price: number
			availabilityStatus: string
		}>
	}
	modifierGroups?: PublicModifierGroupContext[]
	[key: string]: unknown
}

const publicMenuItemContextSchema: z.ZodType<PublicMenuItemContext> = z.lazy(
	() =>
		z
			.object({
				id: z.string().min(1),
				displayName: z.string(),
				price: z.number().finite().min(0),
				availabilityStatus: availabilityStatusSchema,
				variations: z
					.object({
						groups: z
							.array(
								z.object({
									id: z.string(),
									name: z.string(),
									values: z
										.array(z.object({ id: z.string(), name: z.string() }))
										.optional(),
								}),
							)
							.optional(),
						variants: z
							.array(
								z.object({
									id: z.string(),
									valueIds: z.array(z.string()).optional(),
									price: z.number().finite().min(0),
									availabilityStatus: availabilityStatusSchema,
								}),
							)
							.optional(),
					})
					.optional(),
				modifierGroups: z.array(publicModifierGroupContextSchema).optional(),
			})
			.passthrough(),
)

export type PublicMenuCategoryContext = {
	id: string
	displayName: string
	availabilityStatus: string
	items?: PublicMenuItemContext[]
	subcategories?: PublicMenuCategoryContext[]
	[key: string]: unknown
}

const publicMenuCategoryContextSchema: z.ZodType<PublicMenuCategoryContext> =
	z.lazy(() =>
		z
			.object({
				id: z.string().min(1),
				displayName: z.string(),
				availabilityStatus: availabilityStatusSchema,
				items: z.array(publicMenuItemContextSchema).optional(),
				subcategories: z.array(publicMenuCategoryContextSchema).optional(),
			})
			.passthrough(),
	)

export type PublicMenuContext = {
	id: string
	displayName: string
	menuType: string
	specialInstructions?: boolean
	availabilityStatus: string
	categories?: PublicMenuCategoryContext[]
	[key: string]: unknown
}

const publicMenuContextSchema: z.ZodType<PublicMenuContext> = z.lazy(() =>
	z
		.object({
			id: z.string().min(1),
			displayName: z.string(),
			menuType: z.string(),
			specialInstructions: z.boolean().optional(),
			availabilityStatus: availabilityStatusSchema,
			categories: z.array(publicMenuCategoryContextSchema).optional(),
		})
		.passthrough(),
)

const weeklyScheduleContextSchema = z.array(
	z.object({
		day: z.enum(DAYS_OF_WEEK),
		isOpen: z.boolean(),
		slots: z
			.array(
				z.object({
					start: z.string().regex(HH_MM_REGEX),
					end: z.string().regex(HH_MM_REGEX),
				}),
			)
			.default([]),
	}),
)

const specialHoursContextSchema = z
	.array(
		z.object({
			id: z.string(),
			date: z.string().regex(ISO_DATE_REGEX),
			isOpen: z.boolean(),
			slots: z
				.array(
					z.object({
						start: z.string().regex(HH_MM_REGEX),
						end: z.string().regex(HH_MM_REGEX),
					}),
				)
				.default([]),
			note: z.string().optional(),
		}),
	)
	.default([])

const deliveryZoneContextSchema = z.object({
	id: z.string(),
	name: z.string(),
	provider: z.enum(['in_house', 'uber_eats', 'doordash', 'restricted']),
	restriction: z.enum(['allowed', 'disallowed']),
	type: z.enum(['radius', 'zip_code', 'polygon']),
	radius: z
		.object({
			value: z.number().min(0),
			unit: z.enum(['miles', 'km']),
		})
		.optional(),
	zipCodes: z.array(z.string()).default([]),
	polygon: z.array(z.object({ lat: z.number(), lng: z.number() })).default([]),
	minimumOrder: z.number().min(0).default(0),
	deliveryFee: z.number().min(0).default(0),
	enabled: z.boolean().default(true),
})

export const publicLocationContextSchema = z
	.object({
		id: z.string().min(1),
		name: z.string(),
		slug: z.string().optional(),
		phone: z.string().nullable().optional(),
		timezone: z.string().default('UTC'),
		taxRate: z.number().finite().min(0).default(0),
		prepTime: z.number().int().min(0).default(15),
		currency: z.enum(['USD', 'CAD', 'SAR']).default('USD'),
		isDefault: z.boolean().optional(),
		fulfillmentOptions: z
			.object({
				pickup: z.boolean().default(true),
				delivery: z.boolean().default(true),
				dineIn: z.boolean().default(true),
				curbside: z.boolean().default(false),
			})
			.passthrough()
			.default({ pickup: true, delivery: true, dineIn: true, curbside: false }),
		inHouseTips: z
			.object({
				pickupTips: z.boolean().default(true),
				deliveryTips: z.boolean().default(true),
				dineInTips: z.boolean().default(true),
			})
			.passthrough()
			.default({
				pickupTips: true,
				deliveryTips: true,
				dineInTips: true,
			}),
		scheduling: z
			.object({
				scheduledOrdersEnabled: z.boolean().default(true),
				advanceOrderDays: z.number().int().min(1).max(90).default(7),
			})
			.passthrough()
			.optional(),
		deliveryConfig: z
			.object({
				providers: z
					.array(z.enum(['in_house', 'uber_eats', 'doordash', 'restricted']))
					.default([]),
				estimatedDeliveryTimeMin: z.number().min(0),
				estimatedDeliveryTimeMax: z.number().min(0),
			})
			.passthrough()
			.optional(),
		deliveryZones: z.array(deliveryZoneContextSchema).default([]),
		onlineHours: weeklyScheduleContextSchema.nullable().optional(),
		storeHours: weeklyScheduleContextSchema.nullable().optional(),
		specialHours: specialHoursContextSchema.optional(),
	})
	.passthrough()

export type PublicLocationContext = z.infer<typeof publicLocationContextSchema>

export const restaurantOrderContextSchema = z
	.object({
		orgId: z.string().min(1),
		dataRegion: z.enum(['us', 'ksa']),
		menu: z
			.object({
				organization: z
					.object({
						id: z.string().min(1),
						name: z.string().optional(),
						slug: z.string(),
						currency: z.string().min(3).max(3),
						defaultLocale: z.string().optional(),
						locales: z.array(z.string()).optional(),
					})
					.passthrough(),
				locations: z.array(publicLocationContextSchema).default([]),
				menus: z.array(publicMenuContextSchema).default([]),
				locationOverrides: z
					.record(z.string(), z.array(locationOverrideSchema))
					.optional(),
			})
			.passthrough(),
		drop: z
			.object({
				organization: z
					.object({
						id: z.string().min(1),
						name: z.string().optional(),
						slug: z.string(),
						currency: z.string().min(3).max(3),
					})
					.passthrough(),
				drop: z
					.object({
						id: z.string().min(1),
						title: z.string(),
						slug: z.string().min(1),
						description: z.string().nullable().optional(),
						status: z.string(),
						ordersOpenAt: z.string().nullable().optional(),
						ordersCloseAt: z.string().nullable().optional(),
						visibility: z.enum(['public', 'unlisted']).optional(),
						checkoutHoldMinutes: z
							.number()
							.default(RESTAURANT_ONLINE_HOLD_MINUTES),
						menu: z
							.object({
								id: z.string().min(1),
								displayName: z.string().optional(),
								specialInstructions: z.boolean().default(true),
							})
							.passthrough(),
					})
					.passthrough(),
				pickupWindows: z
					.array(
						z
							.object({
								id: z.string().min(1),
								locationId: z.string().min(1),
								location: z
									.object({
										id: z.string().min(1),
										name: z.string().optional(),
										phone: z.string().nullable().optional(),
										timezone: z.string().optional(),
									})
									.passthrough()
									.nullable()
									.optional(),
								date: z.string().regex(ISO_DATE_REGEX),
								startTime: z.string().regex(HH_MM_REGEX),
								endTime: z.string().regex(HH_MM_REGEX),
								slotIntervalMinutes: z.number().int().min(1).default(30),
								maxOrdersPerSlot: z.number().int().min(1).nullable().optional(),
								orderLeadTimeMinutes: z.number().int().min(0).default(0),
								slots: z
									.array(
										z.object({
											time: z.string().regex(HH_MM_REGEX),
											displayTime: z.string().optional(),
										}),
									)
									.default([]),
							})
							.passthrough(),
					)
					.default([]),
				inventoryOverrides: z
					.array(
						z
							.object({
								id: z.string().optional(),
								entityType: z.enum(['item', 'category']),
								entityId: z.string().min(1),
								inventory: z.number().int().min(0).nullable().optional(),
								maxPerOrder: z.number().int().min(1).nullable().optional(),
								maxPerPickupSlot: z.number().int().min(1).nullable().optional(),
							})
							.passthrough(),
					)
					.default([]),
				categories: z.array(publicMenuCategoryContextSchema).default([]),
			})
			.passthrough()
			.nullable(),
		onlinePayment: z.object({
			enabled: z.boolean(),
			processor: z.enum(['connect', 'checkout']).nullable(),
		}),
	})
	.passthrough()

export type RestaurantOrderContext = z.infer<
	typeof restaurantOrderContextSchema
>
export type DropInventoryOverride = NonNullable<
	RestaurantOrderContext['drop']
>['inventoryOverrides'][number]
export type DropPickupWindowContext = NonNullable<
	RestaurantOrderContext['drop']
>['pickupWindows'][number]

// ---------------------------------------------------------------------------
// Priced order output types (stored verbatim as the order's `lines` JSON)
// ---------------------------------------------------------------------------

export type PricedOptionLine = {
	groupId: string
	groupName: string
	optionId: string
	optionName: string
	half: 'whole' | 'left' | 'right' | null
	quantity: number
	priceCents: number
	totalCents: number
}

export type PricedOrderLine = {
	itemId: string
	itemName: string
	variantId: string | null
	quantity: number
	unitPriceCents: number
	taxableUnitCents: number
	totalCents: number
	taxableCents: number
	instructions: string | null
	options: PricedOptionLine[]
}

export type OrderCapacityEntitySpec = {
	kind: 'item' | 'category'
	entityId: string
	quantity: number
	inventory: number | null
	maxPerPickupSlot: number | null
}

export type OrderCapacitySpec = {
	/** Drop these caps belong to; aggregate counts never leak across drops. */
	dropId: string
	windowId: string
	slotTime: string
	maxOrdersPerSlot: number | null
	entities: OrderCapacityEntitySpec[]
}

export type PricedRestaurantOrder = {
	currency: string
	lines: PricedOrderLine[]
	subtotalCents: number
	taxCents: number
	tipCents: number
	tipPercent: number
	deliveryFeeCents: number
	totalCents: number
	location: { id: string; name: string; timezone: string }
	pickup: {
		windowId: string
		date: string
		time: string
		timezone: string
	} | null
	drop: { id: string; slug: string; title: string; menuId: string } | null
	delivery: {
		address: string
		city: string
		unit: string | null
		notes: string | null
		zoneId: string
	} | null
	holdMinutes: number
	capacity: OrderCapacitySpec | null
}

// ---------------------------------------------------------------------------
// Delivery coverage verification (fail closed; fees come only from the zone)
// ---------------------------------------------------------------------------

export type DeliveryCoverageResult =
	| { ok: true; zone: DeliveryZoneLike }
	| { ok: false; error: RestaurantOrderError }

type DeliveryZoneLike = {
	id: string
	name: string
	minimumOrder: number
	deliveryFee: number
	zipCodes: string[]
	type: 'radius' | 'zip_code' | 'polygon'
	provider: string
	restriction: string
	enabled: boolean
}

const US_ZIP_REGEX = /\b(\d{5})(?:-\d{4})?\b/g
const CA_POSTAL_REGEX = /\b([A-Za-z]\d[A-Za-z])[ -]?(\d[A-Za-z]\d)\b/g

/**
 * Extracts a verifiable postal code from freeform delivery text. Radius and
 * polygon zones need coordinates the order payload does not carry, so only
 * zip-code zones can be verified server-side; anything else fails closed.
 */
export function extractPostalCode(text: string): string | null {
	let usMatch: RegExpExecArray | null = null
	let match: RegExpExecArray | null
	US_ZIP_REGEX.lastIndex = 0
	while ((match = US_ZIP_REGEX.exec(text)) !== null) usMatch = match
	if (usMatch) return usMatch[1]!

	let caMatch: RegExpExecArray | null = null
	CA_POSTAL_REGEX.lastIndex = 0
	while ((match = CA_POSTAL_REGEX.exec(text)) !== null) caMatch = match
	if (caMatch) return `${caMatch[1]!}${caMatch[2]!}`.toUpperCase()
	return null
}

function normalizeZip(value: string): string {
	return value.trim().toUpperCase().replace(/\s+/g, '')
}

/**
 * True when at least one enabled, allowed, in-house zip-code zone exists, i.e.
 * delivery coverage is verifiable server-side for some addresses.
 */
export function deliveryCoverageVerifiable(
	location: Pick<PublicLocationContext, 'deliveryZones' | 'deliveryConfig'>,
): boolean {
	const providers = location.deliveryConfig?.providers ?? []
	const zones = location.deliveryZones ?? []
	const eligible = zones.filter(
		(zone) =>
			zone.enabled &&
			zone.restriction === 'allowed' &&
			zone.provider === 'in_house' &&
			zone.type === 'zip_code',
	)
	return providers.includes('in_house') || eligible.length > 0
}

export function resolveDeliveryCoverage(
	location: Pick<
		PublicLocationContext,
		'fulfillmentOptions' | 'deliveryZones' | 'deliveryConfig'
	>,
	delivery: { address: string; city: string },
): DeliveryCoverageResult {
	if (!location.fulfillmentOptions.delivery) {
		return {
			ok: false,
			error: {
				status: 422,
				code: 'delivery_disabled',
				message: 'Delivery is not available at this location.',
			},
		}
	}
	const providers = location.deliveryConfig?.providers ?? []
	const zones = location.deliveryZones ?? []
	const eligible = zones.filter(
		(zone) =>
			zone.enabled &&
			zone.restriction === 'allowed' &&
			zone.provider === 'in_house',
	)
	if (!providers.includes('in_house') && eligible.length === 0) {
		return {
			ok: false,
			error: {
				status: 422,
				code: 'delivery_unavailable',
				message: 'Delivery is not available at this location.',
			},
		}
	}
	const postal = extractPostalCode(`${delivery.address} ${delivery.city}`)
	if (!postal) {
		return {
			ok: false,
			error: {
				status: 422,
				code: 'delivery_coverage_unverified',
				message:
					'We could not verify delivery coverage for this address. Include a postal code or choose pickup.',
			},
		}
	}
	const normalized = normalizeZip(postal)
	const zone = eligible.find(
		(candidate) =>
			candidate.type === 'zip_code' &&
			candidate.zipCodes.some((code) => normalizeZip(code) === normalized),
	)
	if (!zone) {
		return {
			ok: false,
			error: {
				status: 422,
				code: 'delivery_coverage_unverified',
				message:
					'Delivery is not available for this address. Please choose pickup instead.',
			},
		}
	}
	return { ok: true, zone }
}

// ---------------------------------------------------------------------------
// Catalog resolution (published catalog membership, availability, overrides)
// ---------------------------------------------------------------------------

type EntityOverride = {
	isEnabled: boolean | null
	price: number | null
	availabilityStatus: string | null
}

function overrideFor(
	overrides: LocationOverride[] | undefined,
	entityId: string,
) {
	return overrides?.find((override) => override.entityId === entityId)
}

function entityOverride(
	overrides: LocationOverride[] | undefined,
	entityId: string,
): EntityOverride | null {
	const found = overrideFor(overrides, entityId)
	if (!found) return null
	return {
		isEnabled: found.isEnabled ?? null,
		price: found.price ?? null,
		availabilityStatus: found.availabilityStatus ?? null,
	}
}

function optionEffectiveStatus(
	option: PublicMenuOptionContext,
	overrides: LocationOverride[] | undefined,
): string {
	const override = entityOverride(overrides, option.id)
	return override?.availabilityStatus ?? option.availabilityStatus
}

function optionPriceCents(
	option: PublicMenuOptionContext,
	overrides: LocationOverride[] | undefined,
	half?: 'whole' | 'left' | 'right' | null,
): number {
	const override = entityOverride(overrides, option.id)
	const base =
		override?.price != null && override.price > 0
			? override.price
			: option.price
	if (!half || half === 'whole') {
		return dollarsToCents(option.priceWhole ?? base)
	}
	if (half === 'left') return dollarsToCents(option.priceLeft ?? base)
	return dollarsToCents(option.priceRight ?? base)
}

function optionDisabled(
	option: PublicMenuOptionContext,
	overrides: LocationOverride[] | undefined,
): boolean {
	const override = entityOverride(overrides, option.id)
	return override?.isEnabled === false
}

type CatalogEntry = {
	item: PublicMenuItemContext
	categoryIds: string[]
	specialInstructions: boolean
}

type ResolvedCatalog = Map<string, CatalogEntry>

function collectMenuCategories(
	categories: PublicMenuCategoryContext[],
	overrides: LocationOverride[] | undefined,
	visit: (category: PublicMenuCategoryContext) => void,
): void {
	for (const category of categories) {
		const override = entityOverride(overrides, category.id)
		if (override?.isEnabled === false) continue
		const status = override?.availabilityStatus ?? category.availabilityStatus
		if (status !== 'available') continue
		visit(category)
		if (category.subcategories?.length) {
			collectMenuCategories(category.subcategories, overrides, visit)
		}
	}
}

function findNestedGroup(
	groups: PublicModifierGroupContext[],
	groupId: string,
): PublicModifierGroupContext | null {
	for (const group of groups) {
		if (group.id === groupId) return group
		for (const option of group.options ?? []) {
			const nested = option.nestedModifierGroups
			if (!nested?.length) continue
			const found = findNestedGroup(nested, groupId)
			if (found) return found
		}
	}
	return null
}

// ---------------------------------------------------------------------------
// Modifier validation + pricing
// ---------------------------------------------------------------------------

type ResolvedSelection = {
	group: PublicModifierGroupContext
	option: PublicMenuOptionContext
	half: 'whole' | 'left' | 'right' | null
	quantity: number
}

type ModifierResult =
	| {
			ok: true
			options: PricedOptionLine[]
			optionCents: number
			taxableCents: number
	  }
	| { ok: false; error: RestaurantOrderError }

function priceModifierSelections(
	item: PublicMenuItemContext,
	selections: Array<{
		groupId: string
		optionId: string
		half?: 'whole' | 'left' | 'right'
		quantity?: number
	}>,
	overrides: LocationOverride[] | undefined,
): ModifierResult {
	const fail = (error: RestaurantOrderError): ModifierResult => ({
		ok: false,
		error,
	})

	// Groups currently offered: the item's direct available groups, plus nested
	// groups unlocked by selecting their parent option.
	const allowedGroups = new Map<string, PublicModifierGroupContext>()
	for (const group of item.modifierGroups ?? []) {
		if (group.availabilityStatus !== 'available') continue
		allowedGroups.set(group.id, group)
	}

	const pending = selections.map((selection) => ({
		...selection,
		half: selection.half ?? null,
		quantity: selection.quantity ?? null,
	}))
	const resolved: ResolvedSelection[] = []

	let passes = 0
	while (pending.length > 0) {
		if (passes++ > MAX_MODIFIER_FIXPOINT_PASSES) {
			return fail({
				status: 400,
				code: 'unknown_modifier_group',
				message: 'That choice is not available for this item.',
			})
		}
		let progressed = false
		for (let index = pending.length - 1; index >= 0; index -= 1) {
			const selection = pending[index]!
			const group = allowedGroups.get(selection.groupId)
			if (!group) continue
			const option = (group.options ?? []).find(
				(candidate) => candidate.id === selection.optionId,
			)
			if (!option) {
				return fail({
					status: 400,
					code: 'unknown_option',
					message: `That choice is not available for ${group.name}.`,
				})
			}
			if (optionDisabled(option, overrides)) {
				return fail({
					status: 400,
					code: 'option_unavailable',
					message: `${option.displayName} is not available.`,
				})
			}
			if (optionEffectiveStatus(option, overrides) !== 'available') {
				return fail({
					status: 400,
					code: 'option_unavailable',
					message: `${option.displayName} is not available.`,
				})
			}
			// Half is only meaningful for pizza groups.
			if (selection.half && group.selectionType !== 'pizza') {
				return fail({
					status: 400,
					code: 'invalid_half',
					message: `Half selections are not valid for ${group.name}.`,
				})
			}
			// Quantity is only meaningful for quantity groups.
			if (
				selection.quantity != null &&
				group.selectionType !== 'quantity' &&
				selection.quantity !== 1
			) {
				return fail({
					status: 400,
					code: 'invalid_quantity',
					message: `Quantities are not valid for ${group.name}.`,
				})
			}
			resolved.push({
				group,
				option,
				half:
					group.selectionType === 'pizza' ? (selection.half ?? 'whole') : null,
				quantity: selection.quantity ?? 1,
			})
			// Unlock this option's nested modifier groups.
			const nestedIds = option.nestedModifierGroupIds ?? []
			const attachedNested = option.nestedModifierGroups ?? []
			for (const nestedId of nestedIds) {
				if (allowedGroups.has(nestedId)) continue
				const nested =
					attachedNested.find((candidate) => candidate.id === nestedId) ??
					findNestedGroup(item.modifierGroups ?? [], nestedId)
				if (nested && nested.availabilityStatus === 'available') {
					allowedGroups.set(nestedId, nested)
				}
			}
			for (const nested of attachedNested) {
				if (
					!allowedGroups.has(nested.id) &&
					nested.availabilityStatus === 'available'
				) {
					allowedGroups.set(nested.id, nested)
				}
			}
			pending.splice(index, 1)
			progressed = true
		}
		if (!progressed) {
			const selection = pending[0]!
			const hasGroup = (item.modifierGroups ?? []).some(
				(group) => group.id === selection.groupId,
			)
			return fail({
				status: 400,
				code: hasGroup ? 'option_unavailable' : 'unknown_modifier_group',
				message: 'That choice is not available for this item.',
			})
		}
	}

	// Aggregate per group and enforce selection rules.
	const byGroup = new Map<string, ResolvedSelection[]>()
	for (const selection of resolved) {
		const list = byGroup.get(selection.group.id) ?? []
		list.push(selection)
		byGroup.set(selection.group.id, list)
	}

	const pricedOptions: PricedOptionLine[] = []
	let optionCents = 0
	let taxableCents = 0

	for (const [groupId, selections] of byGroup) {
		const group = allowedGroups.get(groupId)!
		const type = group.selectionType
		const min = group.minSelections ?? 0
		const max = group.maxSelections ?? null

		if (type === 'single' || type === 'multiple') {
			const distinctIds = new Set(
				selections.map((selection) => selection.option.id),
			)
			if (distinctIds.size !== selections.length) {
				return fail({
					status: 400,
					code: 'duplicate_option',
					message: `${group.name} cannot contain the same choice twice.`,
				})
			}
			const effectiveMax =
				max ?? (type === 'single' ? 1 : Number.POSITIVE_INFINITY)
			if (selections.length < min) {
				return fail({
					status: 400,
					code: 'required_modifier',
					message:
						min === 1
							? `Please choose ${group.name}.`
							: `${group.name}: choose at least ${min} options.`,
				})
			}
			if (selections.length > effectiveMax) {
				return fail({
					status: 400,
					code: 'modifier_limit',
					message: `${group.name}: choose at most ${effectiveMax} options.`,
				})
			}
			for (const selection of selections) {
				const priceCents = optionPriceCents(selection.option, overrides)
				optionCents += priceCents
				if (selection.option.applySalesTax !== false) taxableCents += priceCents
				pricedOptions.push({
					groupId,
					groupName: group.name,
					optionId: selection.option.id,
					optionName: selection.option.displayName,
					half: null,
					quantity: 1,
					priceCents,
					totalCents: priceCents,
				})
			}
			continue
		}

		if (type === 'quantity') {
			let totalQuantity = 0
			for (const selection of selections) {
				const quantity = selection.quantity ?? 1
				const optionMax =
					selection.option.maxSelections ?? max ?? RESTAURANT_MAX_LINE_QUANTITY
				if (quantity < 1) {
					return fail({
						status: 400,
						code: 'invalid_quantity',
						message: `${group.name}: choose at least one.`,
					})
				}
				if (quantity > optionMax) {
					return fail({
						status: 400,
						code: 'option_quantity_limit',
						message: `${selection.option.displayName}: maximum ${optionMax}.`,
					})
				}
				totalQuantity += quantity
			}
			if (totalQuantity < min) {
				return fail({
					status: 400,
					code: 'required_modifier',
					message:
						min === 1
							? `Please choose ${group.name}.`
							: `${group.name}: choose at least ${min}.`,
				})
			}
			if (max != null && totalQuantity > max) {
				return fail({
					status: 400,
					code: 'modifier_limit',
					message: `${group.name}: choose at most ${max}.`,
				})
			}
			for (const selection of selections) {
				const quantity = selection.quantity ?? 1
				const priceCents = optionPriceCents(selection.option, overrides)
				const total = priceCents * quantity
				optionCents += total
				if (selection.option.applySalesTax !== false) taxableCents += total
				pricedOptions.push({
					groupId,
					groupName: group.name,
					optionId: selection.option.id,
					optionName: selection.option.displayName,
					half: null,
					quantity,
					priceCents,
					totalCents: total,
				})
			}
			continue
		}

		// pizza
		const seen = new Set<string>()
		const optionHalves = new Map<string, Set<string>>()
		for (const selection of selections) {
			const key = `${selection.option.id}::${selection.half ?? 'whole'}`
			if (seen.has(key)) {
				return fail({
					status: 400,
					code: 'duplicate_option',
					message: `${group.name} cannot contain the same choice twice.`,
				})
			}
			seen.add(key)
			const halves = optionHalves.get(selection.option.id) ?? new Set<string>()
			halves.add(selection.half ?? 'whole')
			optionHalves.set(selection.option.id, halves)
		}
		for (const [optionId, halves] of optionHalves) {
			if (halves.has('whole') && halves.size > 1) {
				return fail({
					status: 400,
					code: 'invalid_combination',
					message: `${group.name}: whole and half choices cannot be combined.`,
				})
			}
			if (halves.has('left') && halves.has('right')) {
				// left + right of the same option is a valid "split" selection.
			}
			void optionId
		}
		const effectiveMax = max ?? Number.POSITIVE_INFINITY
		if (selections.length < min) {
			return fail({
				status: 400,
				code: 'required_modifier',
				message:
					min === 1
						? `Please choose ${group.name}.`
						: `${group.name}: choose at least ${min}.`,
			})
		}
		if (selections.length > effectiveMax) {
			return fail({
				status: 400,
				code: 'modifier_limit',
				message: `${group.name}: choose at most ${effectiveMax}.`,
			})
		}
		for (const selection of selections) {
			const half = selection.half ?? 'whole'
			const priceCents = optionPriceCents(selection.option, overrides, half)
			optionCents += priceCents
			if (selection.option.applySalesTax !== false) taxableCents += priceCents
			pricedOptions.push({
				groupId,
				groupName: group.name,
				optionId: selection.option.id,
				optionName: selection.option.displayName,
				half,
				quantity: 1,
				priceCents,
				totalCents: priceCents,
			})
		}
	}

	// Every offered group must satisfy its minimum. Groups that were never
	// offered (nested under an unselected option) impose nothing.
	for (const group of allowedGroups.values()) {
		const selections = byGroup.get(group.id) ?? []
		const satisfied =
			group.selectionType === 'quantity'
				? selections.reduce(
						(sum, selection) => sum + (selection.quantity ?? 1),
						0,
					)
				: selections.length
		if ((group.minSelections ?? 0) > satisfied) {
			const min = group.minSelections ?? 0
			return fail({
				status: 400,
				code: 'required_modifier',
				message:
					min === 1
						? `Please choose ${group.name}.`
						: `${group.name}: choose at least ${min}.`,
			})
		}
	}

	return { ok: true, options: pricedOptions, optionCents, taxableCents }
}

// ---------------------------------------------------------------------------
// Repricing engine
// ---------------------------------------------------------------------------

function orderError(
	status: RestaurantOrderError['status'],
	code: RestaurantOrderErrorCode,
	message: string,
): RestaurantOrderError {
	return { status, code, message }
}

/**
 * Re-derives every cent and every constraint from authoritative catalog data.
 * No browser price, membership, or availability input is trusted.
 */
export function priceRestaurantOrder(
	context: RestaurantOrderContext,
	request: RestaurantOrderRequest,
	options: { now: Date },
): PriceRestaurantOrderResult {
	const { now } = options

	const location = context.menu.locations.find(
		(candidate) => candidate.id === request.locationId,
	)
	if (!location) {
		return {
			ok: false,
			error: orderError(
				404,
				'location_not_found',
				'This location is not available for ordering.',
			),
		}
	}

	const dropSlug = request.dropSlug ?? null
	if (dropSlug && !request.pickup) {
		return {
			ok: false,
			error: orderError(400, 'pickup_required', 'Choose a pickup time.'),
		}
	}
	if (!dropSlug && request.pickup) {
		return {
			ok: false,
			error: orderError(
				400,
				'pickup_not_supported',
				'Pickup windows are only available for drops.',
			),
		}
	}
	if (request.fulfillment === 'delivery' && !request.delivery) {
		return {
			ok: false,
			error: orderError(
				400,
				'delivery_address_required',
				'A delivery address is required.',
			),
		}
	}
	if (request.fulfillment !== 'delivery' && request.delivery) {
		return {
			ok: false,
			error: orderError(
				400,
				'delivery_not_allowed',
				'Delivery details are not valid for pickup orders.',
			),
		}
	}
	if (request.fulfillment === 'pickup' && !location.fulfillmentOptions.pickup) {
		return {
			ok: false,
			error: orderError(
				422,
				'pickup_disabled',
				'Pickup is not available at this location.',
			),
		}
	}
	if (
		request.fulfillment === 'delivery' &&
		!location.fulfillmentOptions.delivery
	) {
		return {
			ok: false,
			error: orderError(
				422,
				'delivery_disabled',
				'Delivery is not available at this location.',
			),
		}
	}
	const tipsEnabled =
		request.fulfillment === 'pickup'
			? location.inHouseTips.pickupTips
			: location.inHouseTips.deliveryTips
	if (request.tipPercent > 0 && !tipsEnabled) {
		return {
			ok: false,
			error: orderError(
				422,
				'tips_disabled',
				'Tips are not accepted for this order.',
			),
		}
	}

	// ---- Catalog + drop resolution ------------------------------------------
	const locationOverrides = dropSlug
		? undefined
		: (context.menu.locationOverrides?.[location.id] ?? undefined)
	const catalog: ResolvedCatalog = new Map()
	let dropInfo: PricedRestaurantOrder['drop'] = null
	let pickupInfo: PricedRestaurantOrder['pickup'] = null
	let holdMinutes = RESTAURANT_ONLINE_HOLD_MINUTES
	let capacity: OrderCapacitySpec | null = null
	let inventoryOverrides: DropInventoryOverride[] = []
	const itemRules = new Map<string, DropInventoryOverride>()
	const categoryRules = new Map<string, DropInventoryOverride>()
	let currency: string = location.currency || context.menu.organization.currency

	if (dropSlug) {
		const dropData = context.drop
		if (
			!dropData ||
			dropData.drop.slug.toLowerCase() !== dropSlug.toLowerCase()
		) {
			return {
				ok: false,
				error: orderError(404, 'drop_not_found', 'This drop is not available.'),
			}
		}
		if (dropData.drop.status === 'draft') {
			return {
				ok: false,
				error: orderError(404, 'drop_not_found', 'This drop is not available.'),
			}
		}
		const displayStatus = getDropDisplayStatus(
			dropData.drop.status as
				'draft' | 'scheduled' | 'live' | 'closed' | 'completed',
			dropData.drop.ordersOpenAt ?? null,
			dropData.drop.ordersCloseAt ?? null,
			now,
		)
		if (displayStatus !== 'live') {
			return {
				ok: false,
				error: orderError(
					422,
					'drop_closed',
					'Orders are closed for this drop.',
				),
			}
		}
		const pickup = request.pickup!
		const window = dropData.pickupWindows.find(
			(candidate) => candidate.id === pickup.windowId,
		)
		if (!window || window.locationId !== location.id) {
			return {
				ok: false,
				error: orderError(
					400,
					'invalid_pickup_window',
					'Choose a valid pickup window.',
				),
			}
		}
		// Regenerate slots exactly; never trust a possibly stale slot list.
		const slots = generatePickupSlots(
			window.startTime,
			window.endTime,
			window.slotIntervalMinutes,
		)
		if (!slots.some((slot) => slot.time === pickup.time)) {
			return {
				ok: false,
				error: orderError(
					400,
					'invalid_pickup_slot',
					'Choose a valid pickup time.',
				),
			}
		}
		const timezone = window.location?.timezone || location.timezone || 'UTC'
		const slotStart = localDateAndTimeToUtc(window.date, pickup.time, timezone)
		const leadTimeMs = window.orderLeadTimeMinutes * 60 * 1000
		if (slotStart.getTime() < now.getTime() + leadTimeMs) {
			return {
				ok: false,
				error: orderError(
					422,
					'lead_time',
					'That pickup time is no longer available. Please choose a later slot.',
				),
			}
		}

		holdMinutes = clampInt(
			dropData.drop.checkoutHoldMinutes,
			RESTAURANT_MIN_HOLD_MINUTES,
			RESTAURANT_MAX_HOLD_MINUTES,
			RESTAURANT_ONLINE_HOLD_MINUTES,
		)
		dropInfo = {
			id: dropData.drop.id,
			slug: dropData.drop.slug,
			title: dropData.drop.title,
			menuId: dropData.drop.menu.id,
		}
		pickupInfo = {
			windowId: window.id,
			date: window.date,
			time: pickup.time,
			timezone,
		}
		inventoryOverrides = dropData.inventoryOverrides
		for (const override of inventoryOverrides) {
			if (override.entityType === 'item')
				itemRules.set(override.entityId, override)
			else categoryRules.set(override.entityId, override)
		}

		// Published catalog membership for a drop is the drop's own categories.
		for (const category of dropData.categories) {
			if (category.availabilityStatus !== 'available') continue
			for (const item of category.items ?? []) {
				const existing = catalog.get(item.id)
				const categoryIds = new Set(existing?.categoryIds ?? [])
				categoryIds.add(category.id)
				catalog.set(item.id, {
					item,
					categoryIds: [...categoryIds],
					specialInstructions: dropData.drop.menu.specialInstructions ?? true,
				})
			}
		}
		currency = dropData.organization.currency || currency
	} else {
		const availability = isLocationOpenForOrdering(location, now)
		if (!availability.isOpen) {
			return {
				ok: false,
				error: orderError(
					422,
					'ordering_closed',
					availability.reason || 'Ordering is currently closed.',
				),
			}
		}
		for (const menu of context.menu.menus) {
			if (menu.menuType === 'drop' || menu.availabilityStatus !== 'available') {
				continue
			}
			collectMenuCategories(
				menu.categories ?? [],
				locationOverrides,
				(category) => {
					for (const item of category.items ?? []) {
						const itemOverride = entityOverride(locationOverrides, item.id)
						if (itemOverride?.isEnabled === false) continue
						const status =
							itemOverride?.availabilityStatus ?? item.availabilityStatus
						if (status !== 'available') continue
						const effectiveItem =
							itemOverride?.price != null && itemOverride.price > 0
								? { ...item, price: itemOverride.price }
								: item
						const existing = catalog.get(item.id)
						const categoryIds = new Set(existing?.categoryIds ?? [])
						categoryIds.add(category.id)
						catalog.set(item.id, {
							item: effectiveItem,
							categoryIds: [...categoryIds],
							specialInstructions:
								menu.specialInstructions ||
								(existing?.specialInstructions ?? false),
						})
					}
				},
			)
		}
	}

	// ---- Line validation + repricing ----------------------------------------
	const pricedLines: PricedOrderLine[] = []
	const itemQuantityTotals = new Map<string, number>()
	const categoryQuantityTotals = new Map<string, number>()
	const capacityEntities = new Map<
		string,
		{
			kind: 'item' | 'category'
			entityId: string
			quantity: number
			inventory: number | null
			maxPerPickupSlot: number | null
		}
	>()

	for (const line of request.lines) {
		const entry = catalog.get(line.itemId)
		if (!entry) {
			return {
				ok: false,
				error: orderError(
					400,
					'unknown_item',
					'Your order includes an item that is not available.',
				),
			}
		}
		if (entry.item.availabilityStatus !== 'available') {
			return {
				ok: false,
				error: orderError(
					400,
					'item_unavailable',
					`${entry.item.displayName} is not available right now.`,
				),
			}
		}
		if (line.instructions && !entry.specialInstructions) {
			return {
				ok: false,
				error: orderError(
					400,
					'instructions_not_allowed',
					'Special instructions are not accepted for this order.',
				),
			}
		}

		const variants = entry.item.variations?.variants ?? []
		let variant: (typeof variants)[number] | null = null
		if (variants.length > 0) {
			if (!line.variantId) {
				return {
					ok: false,
					error: orderError(
						400,
						'variant_required',
						`Choose an option for ${entry.item.displayName}.`,
					),
				}
			}
			variant =
				variants.find((candidate) => candidate.id === line.variantId) ?? null
			if (!variant) {
				return {
					ok: false,
					error: orderError(
						400,
						'unknown_variant',
						`That option for ${entry.item.displayName} is not available.`,
					),
				}
			}
			if (variant.availabilityStatus !== 'available') {
				return {
					ok: false,
					error: orderError(
						400,
						'variant_unavailable',
						`That option for ${entry.item.displayName} is not available.`,
					),
				}
			}
		} else if (line.variantId) {
			return {
				ok: false,
				error: orderError(
					400,
					'unknown_variant',
					`That option for ${entry.item.displayName} is not available.`,
				),
			}
		}

		const modifierResult = priceModifierSelections(
			entry.item,
			line.options,
			locationOverrides,
		)
		if (!modifierResult.ok) return { ok: false, error: modifierResult.error }

		const baseCents = dollarsToCents(variant ? variant.price : entry.item.price)
		const unitCents = baseCents + modifierResult.optionCents
		const lineTotal = unitCents * line.quantity
		const lineTaxable =
			baseCents * line.quantity + modifierResult.taxableCents * line.quantity

		pricedLines.push({
			itemId: entry.item.id,
			itemName: entry.item.displayName,
			variantId: variant ? variant.id : null,
			quantity: line.quantity,
			unitPriceCents: unitCents,
			taxableUnitCents: baseCents + modifierResult.taxableCents,
			totalCents: lineTotal,
			taxableCents: lineTaxable,
			instructions: line.instructions ? line.instructions : null,
			options: modifierResult.options,
		})

		itemQuantityTotals.set(
			entry.item.id,
			(itemQuantityTotals.get(entry.item.id) ?? 0) + line.quantity,
		)
		for (const categoryId of entry.categoryIds) {
			categoryQuantityTotals.set(
				categoryId,
				(categoryQuantityTotals.get(categoryId) ?? 0) + line.quantity,
			)
		}
	}

	// ---- Drop capacity rules (per-order caps checked here; aggregates in the DB tx) ----
	if (dropSlug) {
		for (const [itemId, quantity] of itemQuantityTotals) {
			const rule = itemRules.get(itemId)
			if (rule?.maxPerOrder != null && quantity > rule.maxPerOrder) {
				return {
					ok: false,
					error: orderError(
						422,
						'per_order_limit',
						`This order exceeds the limit of ${rule.maxPerOrder} per order for this item.`,
					),
				}
			}
		}
		for (const [categoryId, quantity] of categoryQuantityTotals) {
			const rule = categoryRules.get(categoryId)
			if (rule?.maxPerOrder != null && quantity > rule.maxPerOrder) {
				return {
					ok: false,
					error: orderError(
						422,
						'per_order_limit',
						`This order exceeds the limit of ${rule.maxPerOrder} per order.`,
					),
				}
			}
		}
		for (const line of pricedLines) {
			const itemRule = itemRules.get(line.itemId)
			if (
				itemRule &&
				(itemRule.inventory != null || itemRule.maxPerPickupSlot != null)
			) {
				const key = `item:${line.itemId}`
				const entity = capacityEntities.get(key) ?? {
					kind: 'item' as const,
					entityId: line.itemId,
					quantity: 0,
					inventory: itemRule.inventory ?? null,
					maxPerPickupSlot: itemRule.maxPerPickupSlot ?? null,
				}
				entity.quantity += line.quantity
				if (itemRule.inventory != null) entity.inventory = itemRule.inventory
				if (itemRule.maxPerPickupSlot != null) {
					entity.maxPerPickupSlot = itemRule.maxPerPickupSlot
				}
				capacityEntities.set(key, entity)
			}
			const entry = catalog.get(line.itemId)!
			for (const categoryId of entry.categoryIds) {
				const rule = categoryRules.get(categoryId)
				if (rule && (rule.inventory != null || rule.maxPerPickupSlot != null)) {
					const key = `category:${categoryId}`
					const entity = capacityEntities.get(key) ?? {
						kind: 'category' as const,
						entityId: categoryId,
						quantity: 0,
						inventory: rule.inventory ?? null,
						maxPerPickupSlot: rule.maxPerPickupSlot ?? null,
					}
					entity.quantity += line.quantity
					if (rule.inventory != null) entity.inventory = rule.inventory
					if (rule.maxPerPickupSlot != null) {
						entity.maxPerPickupSlot = rule.maxPerPickupSlot
					}
					capacityEntities.set(key, entity)
				}
			}
		}
		const window = context.drop!.pickupWindows.find(
			(candidate) => candidate.id === request.pickup!.windowId,
		)!
		capacity = {
			dropId: context.drop!.drop.id,
			windowId: window.id,
			slotTime: request.pickup!.time,
			maxOrdersPerSlot: window.maxOrdersPerSlot ?? null,
			entities: [...capacityEntities.values()],
		}
	}

	// ---- Delivery coverage + fee -------------------------------------------
	let deliveryInfo: PricedRestaurantOrder['delivery'] = null
	let deliveryFeeCents = 0
	if (request.fulfillment === 'delivery' && request.delivery) {
		const coverage = resolveDeliveryCoverage(location, request.delivery)
		if (!coverage.ok) return { ok: false, error: coverage.error }
		const zone = coverage.zone
		deliveryFeeCents = dollarsToCents(zone.deliveryFee)
		deliveryInfo = {
			address: request.delivery.address,
			city: request.delivery.city,
			unit: request.delivery.unit ?? null,
			notes: request.delivery.notes ?? null,
			zoneId: zone.id,
		}
	}

	// ---- Totals --------------------------------------------------------------
	const subtotalCents = pricedLines.reduce(
		(sum, line) => sum + line.totalCents,
		0,
	)
	if (
		deliveryInfo &&
		zoneMinimumOrderCents(subtotalCents, location, deliveryInfo.zoneId)
	) {
		const zone = (location.deliveryZones ?? []).find(
			(candidate) => candidate.id === deliveryInfo!.zoneId,
		)
		return {
			ok: false,
			error: orderError(
				422,
				'minimum_order',
				`The minimum delivery order is ${minimumOrderText(zone?.minimumOrder ?? 0)}.`,
			),
		}
	}
	const taxableCents = pricedLines.reduce(
		(sum, line) => sum + line.taxableCents,
		0,
	)
	const taxRatePercent = Math.max(0, Math.min(100, location.taxRate || 0))
	const taxCents = Math.round((taxableCents * taxRatePercent) / 100)
	const tipCents = Math.round((subtotalCents * request.tipPercent) / 100)
	const totalCents = subtotalCents + taxCents + tipCents + deliveryFeeCents

	return {
		ok: true,
		result: {
			currency,
			lines: pricedLines,
			subtotalCents,
			taxCents,
			tipCents,
			tipPercent: request.tipPercent,
			deliveryFeeCents,
			totalCents,
			location: {
				id: location.id,
				name: location.name,
				timezone: location.timezone || 'UTC',
			},
			pickup: pickupInfo,
			drop: dropInfo,
			delivery: deliveryInfo,
			holdMinutes,
			capacity,
		},
	}
}

function zoneMinimumOrderCents(
	subtotalCents: number,
	location: PublicLocationContext,
	zoneId: string,
): boolean {
	const zone = (location.deliveryZones ?? []).find(
		(candidate) => candidate.id === zoneId,
	)
	if (!zone || !(zone.minimumOrder > 0)) return false
	return subtotalCents < dollarsToCents(zone.minimumOrder)
}

function minimumOrderText(minimumOrder: number): string {
	return minimumOrder.toFixed(2)
}

// ---------------------------------------------------------------------------
// Public ordering options (GET /orders/options) — availability only, no PII
// ---------------------------------------------------------------------------

export type PublicOrderingSlot = {
	time: string
	ordersRemaining: number | null
	leadTimePassed: boolean
}

export type PublicOrderingWindow = {
	id: string
	locationId: string
	date: string
	startTime: string
	endTime: string
	slotIntervalMinutes: number
	orderLeadTimeMinutes: number
	maxOrdersPerSlot: number | null
	timezone: string
	slots: PublicOrderingSlot[]
}

export type PublicOrderingOptions = {
	slug: string | null
	locationId: string
	dropSlug: string | null
	onlinePayment: { enabled: boolean; processor: 'connect' | 'checkout' | null }
	ordering: {
		open: boolean
		status: LocationOrderingAvailability['status']
		reason: string | null
		nextOpen: string | null
	}
	fulfillment: { pickup: boolean; delivery: boolean }
	tips: { pickup: boolean; delivery: boolean }
	delivery: { available: boolean }
	drop: null | {
		slug: string
		title: string
		status: string
		ordersOpenAt: string | null
		ordersCloseAt: string | null
		holdMinutes: number
		windows: PublicOrderingWindow[]
		entityRemaining: {
			items: Record<string, number | null>
			categories: Record<string, number | null>
		}
	}
}

export type OrderingOptionsCounts = {
	/** Active orders per `${windowId}|${slotTime}` */
	slotOrders: Map<string, number>
	/** Reserved quantity per `item|${entityId}` / `category|${entityId}` */
	entityUsed: Map<string, number>
}

/**
 * Builds the public capability/availability response for the ordering UI.
 * Contains only aggregate availability counts — never customer data.
 */
export function buildPublicOrderingOptions(
	context: RestaurantOrderContext,
	input: {
		slug: string | null
		locationId: string
		dropSlug: string | null
		counts: OrderingOptionsCounts
		now: Date
	},
):
	| { ok: true; options: PublicOrderingOptions }
	| { ok: false; error: RestaurantOrderError } {
	const location = context.menu.locations.find(
		(candidate) => candidate.id === input.locationId,
	)
	if (!location) {
		return {
			ok: false,
			error: orderError(
				404,
				'location_not_found',
				'This location is not available for ordering.',
			),
		}
	}
	const availability = isLocationOpenForOrdering(location, input.now)
	const options: PublicOrderingOptions = {
		slug: input.slug,
		locationId: location.id,
		dropSlug: input.dropSlug,
		onlinePayment: {
			enabled: context.onlinePayment.enabled,
			processor: context.onlinePayment.processor,
		},
		ordering: {
			open: availability.isOpen,
			status: availability.status,
			reason: availability.reason ?? null,
			nextOpen: availability.nextOpen ?? null,
		},
		fulfillment: {
			pickup: Boolean(location.fulfillmentOptions.pickup),
			delivery: Boolean(location.fulfillmentOptions.delivery),
		},
		tips: {
			pickup: Boolean(location.inHouseTips.pickupTips),
			delivery: Boolean(location.inHouseTips.deliveryTips),
		},
		delivery: {
			available:
				Boolean(location.fulfillmentOptions.delivery) &&
				deliveryCoverageVerifiable(location),
		},
		drop: null,
	}

	if (input.dropSlug) {
		const dropData = context.drop
		if (
			!dropData ||
			dropData.drop.slug.toLowerCase() !== input.dropSlug.toLowerCase()
		) {
			return {
				ok: false,
				error: orderError(404, 'drop_not_found', 'This drop is not available.'),
			}
		}
		const windows: PublicOrderingWindow[] = []
		for (const window of dropData.pickupWindows) {
			const slots = generatePickupSlots(
				window.startTime,
				window.endTime,
				window.slotIntervalMinutes,
			)
			const timezone = window.location?.timezone || location.timezone || 'UTC'
			const windowSlots: PublicOrderingSlot[] = slots.map((slot) => {
				const used =
					input.counts.slotOrders.get(`${window.id}|${slot.time}`) ?? 0
				const slotStart = localDateAndTimeToUtc(
					window.date,
					slot.time,
					timezone,
				)
				return {
					time: slot.time,
					ordersRemaining:
						window.maxOrdersPerSlot != null
							? Math.max(0, window.maxOrdersPerSlot - used)
							: null,
					leadTimePassed:
						slotStart.getTime() >=
						input.now.getTime() + window.orderLeadTimeMinutes * 60 * 1000,
				}
			})
			windows.push({
				id: window.id,
				locationId: window.locationId,
				date: window.date,
				startTime: window.startTime,
				endTime: window.endTime,
				slotIntervalMinutes: window.slotIntervalMinutes,
				orderLeadTimeMinutes: window.orderLeadTimeMinutes,
				maxOrdersPerSlot: window.maxOrdersPerSlot ?? null,
				timezone,
				slots: windowSlots,
			})
		}

		const items: Record<string, number | null> = {}
		const categories: Record<string, number | null> = {}
		for (const override of dropData.inventoryOverrides) {
			const used =
				input.counts.entityUsed.get(
					`${override.entityType}|${override.entityId}`,
				) ?? 0
			const remaining =
				override.inventory != null
					? Math.max(0, override.inventory - used)
					: null
			if (override.entityType === 'item') items[override.entityId] = remaining
			else categories[override.entityId] = remaining
		}

		options.drop = {
			slug: dropData.drop.slug,
			title: dropData.drop.title,
			status: getDropDisplayStatus(
				dropData.drop.status as
					'draft' | 'scheduled' | 'live' | 'closed' | 'completed',
				dropData.drop.ordersOpenAt ?? null,
				dropData.drop.ordersCloseAt ?? null,
				input.now,
			),
			ordersOpenAt: dropData.drop.ordersOpenAt ?? null,
			ordersCloseAt: dropData.drop.ordersCloseAt ?? null,
			holdMinutes: clampInt(
				dropData.drop.checkoutHoldMinutes,
				RESTAURANT_MIN_HOLD_MINUTES,
				RESTAURANT_MAX_HOLD_MINUTES,
				RESTAURANT_ONLINE_HOLD_MINUTES,
			),
			windows,
			entityRemaining: { items, categories },
		}
	}

	return { ok: true, options }
}
