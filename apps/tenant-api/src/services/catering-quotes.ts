import crypto from 'node:crypto'
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'

import {
	CATERING_DEFAULT_QUOTE_VALID_DAYS,
	cateringQuoteChargeSchema,
	cateringQuoteLineSchema,
	checkCateringLimits,
	priceCateringQuote,
	quoteOrderRef,
	quotePayability,
	readCateringPolicy,
	validateCateringEvent,
	type CateringFailure,
	type CateringLocationPolicy,
	type CateringQuoteCharge,
	type CateringQuoteLine,
	type CateringQuoteRequest,
	type OperatorQuoteWrite,
} from '@repo/common/catering'
import { isLocationOpenForOrdering } from '@repo/common/location-availability'
import {
	dollarsToCents,
	priceRestaurantOrder,
	RESTAURANT_ONLINE_HOLD_MINUTES,
	restaurantOrderQuoteSchema,
	type PricedOptionLine,
	type PricedOrderLine,
	type PublicLocationContext,
	type RestaurantOrderContext,
} from '@repo/common/restaurant-orders'
import {
	cateringQuotes,
	getTenantDb,
	restaurantOrders,
	type CateringQuote,
	type RestaurantOrder,
} from '@repo/tenant-db'

import { isCateringPublicDisabled } from '../lib/catering-switches.ts'
import { deriveQuoteToken, readQuoteToken } from '../lib/catering-tokens.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import {
	onCateringQuoteRequested,
	quoteLinkUrl,
	sendCateringQuoteEmail,
} from './catering-messages.ts'
import { cateringCollectionColumns } from './catering-orders.ts'
import {
	applyPaymentEvent,
	bindPaymentSession,
	derivePaymentToken,
	deriveReceiptToken,
	fetchOrderContext,
	getOrderQuote,
	nextOrderNumber,
	orderFailure,
	runExclusive,
	type OrderServiceResult,
} from './order-service.ts'
import { recordOrderStep } from './order-steps.ts'
import { runTenantTransaction } from '@repo/tenant-db'

/**
 * Catering quotes (#124): a guest's request or a quote an operator wrote, the
 * lines and charges the guest pays, and what paying it becomes.
 *
 * Paying starts the order: the guest's accept creates a pending online catering
 * order from the quote (one at a time) and the payment goes through the order's
 * own payment machinery behind the `quote:<id>` ref (quote, bind and paid
 * events in `order-system.ts`), so a paid quote is a normal paid catering order
 * and the refund, kitchen, loyalty and inventory paths all see it.
 *
 * The guest's link is an HMAC capability of the quote id and version (URL
 * fragment, never stored). Editing a quote that was sent bumps the version, so
 * the old link stops working; the quote goes back to a draft until it is sent
 * again. Everything here is regional: contact, notes and the address never
 * leave the region.
 */

type Fail = { ok: false; failure: CateringFailure & { status: number } }
const failWith = (status: number, failure: CateringFailure): Fail => ({
	ok: false,
	failure: { ...failure, status },
})

function toOrderFailure(f: Fail) {
	return orderFailure(f.failure.status, f.failure.code, f.failure.message, {
		details: f.failure.details,
	})
}

type CateringEnv = {
	context: RestaurantOrderContext
	policy: CateringLocationPolicy | null
	location: PublicLocationContext
}

/** The order context for one location, its catering policy and the location row. */
export async function loadCateringEnv(
	orgId: string,
	locationId: string,
): Promise<OrderServiceResult<CateringEnv>> {
	const fetched = await fetchOrderContext(orgId, locationId, null)
	if (!fetched.ok) return fetched
	const location = fetched.data.menu.locations.find(
		(candidate) => candidate.id === locationId,
	)
	if (!location) {
		return orderFailure(
			404,
			'location_not_found',
			'This location is not available.',
		)
	}
	return {
		ok: true,
		data: {
			context: fetched.data,
			policy: readCateringPolicy(fetched.data.catering, locationId),
			location,
		},
	}
}

function isOpenAtFor(location: PublicLocationContext) {
	return (when: Date) => {
		const open = isLocationOpenForOrdering(
			{ ...location, orderingPause: null, busyMode: null },
			when,
		)
		return { isOpen: open.isOpen, reason: open.reason }
	}
}

// ---------------------------------------------------------------------------
// Line and total helpers
// ---------------------------------------------------------------------------

function parseLines(value: unknown): CateringQuoteLine[] {
	const parsed = cateringQuoteLineSchema.array().safeParse(value)
	return parsed.success ? parsed.data : []
}

function parseCharges(value: unknown): CateringQuoteCharge[] {
	const parsed = cateringQuoteChargeSchema.array().safeParse(value)
	return parsed.success ? parsed.data : []
}

function pricedLineToQuoteLine(line: PricedOrderLine): CateringQuoteLine {
	return {
		lineId: crypto.randomUUID(),
		itemId: line.itemId,
		itemName: line.itemName,
		variantId: line.variantId,
		...(line.variantNames ? { variantNames: line.variantNames } : {}),
		options: line.options.map((option) => ({
			groupName: option.groupName,
			optionName: option.optionName,
			priceCents: option.priceCents,
			quantity: option.quantity,
		})),
		quantity: line.quantity,
		unitPriceCents: line.unitPriceCents,
		taxable: line.taxableUnitCents > 0,
		instructions: line.instructions,
		categoryIds: line.categoryIds,
		...(line.menuId ? { menuId: line.menuId } : {}),
		...(line.menuName ? { menuName: line.menuName } : {}),
		...(line.categoryId ? { categoryId: line.categoryId } : {}),
		...(line.categoryName ? { categoryName: line.categoryName } : {}),
	}
}

/** The kitchen and report shape of a quote line (what the order stores). */
export function quoteLineToPricedLine(
	line: CateringQuoteLine,
): PricedOrderLine {
	const optionsCents = line.options.reduce(
		(sum, option) => sum + option.priceCents * option.quantity,
		0,
	)
	const options: PricedOptionLine[] = line.options.map((option, index) => ({
		groupId: 'catering',
		groupName: option.groupName ?? '',
		optionId: `${line.lineId}:${index}`,
		optionName: option.optionName,
		half: null,
		quantity: option.quantity,
		priceCents: option.priceCents,
		totalCents: option.priceCents * option.quantity,
	}))
	const total = line.unitPriceCents * line.quantity
	return {
		itemId: line.itemId ?? `custom:${line.lineId}`,
		itemName: line.itemName,
		variantId: line.variantId ?? null,
		quantity: line.quantity,
		unitPriceCents: line.unitPriceCents,
		taxableUnitCents: line.taxable ? line.unitPriceCents : 0,
		totalCents: total,
		taxableCents: line.taxable ? total : 0,
		instructions: line.instructions ?? null,
		options,
		baseUnitCents: Math.max(0, line.unitPriceCents - optionsCents),
		categoryIds: line.categoryIds,
		...(line.menuId ? { menuId: line.menuId } : {}),
		...(line.menuName ? { menuName: line.menuName } : {}),
		...(line.categoryId ? { categoryId: line.categoryId } : {}),
		...(line.categoryName ? { categoryName: line.categoryName } : {}),
		...(line.variantNames ? { variantNames: line.variantNames } : {}),
	}
}

function totalsFor(
	lines: CateringQuoteLine[],
	charges: CateringQuoteCharge[],
	location: Pick<PublicLocationContext, 'taxRate' | 'taxInclusive'>,
) {
	return priceCateringQuote({
		lines,
		charges,
		taxRatePercent: location.taxRate || 0,
		taxInclusive: location.taxInclusive === true,
	})
}

function sha256(value: string): string {
	return crypto.createHash('sha256').update(value).digest('hex')
}

/** Menu dishes of the catering menus, by id (the region stamps names and prices itself). */
function cateringMenuItems(context: RestaurantOrderContext) {
	const items = new Map<
		string,
		{
			id: string
			name: string
			priceCents: number
			taxable: boolean
			categoryIds: string[]
			menuId: string
			menuName: string
			categoryId: string
			categoryName: string
		}
	>()
	const visit = (
		categories: Array<{
			id: string
			displayName?: string
			items?: Array<Record<string, unknown>>
			subcategories?: unknown[]
		}>,
		menu: { id: string; displayName?: string },
	) => {
		for (const category of categories) {
			for (const item of category.items ?? []) {
				const id = String(item.id)
				if (items.has(id)) continue
				items.set(id, {
					id,
					name: String(item.displayName ?? ''),
					priceCents: dollarsToCents(Number(item.price ?? 0)),
					taxable: item.applySalesTax !== false,
					categoryIds: [category.id],
					menuId: menu.id,
					menuName: menu.displayName ?? '',
					categoryId: category.id,
					categoryName: category.displayName ?? '',
				})
			}
			if (Array.isArray(category.subcategories)) {
				visit(category.subcategories as never, menu)
			}
		}
	}
	for (const menu of context.menu.menus) {
		if (menu.menuType !== 'catering') continue
		visit((menu.categories ?? []) as never, menu)
	}
	return items
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function operatorQuoteView(quote: CateringQuote) {
	return {
		id: quote.id,
		kind: 'quote' as const,
		locationId: quote.locationId,
		status: quote.status,
		version: quote.version,
		source: quote.source,
		fulfillment: quote.fulfillment,
		eventAt: quote.eventAt,
		guestCount: quote.guestCount,
		contact: {
			name: quote.contactName,
			phone: quote.contactPhone,
			email: quote.contactEmail,
		},
		delivery: quote.delivery ?? null,
		eventNotes: quote.eventNotes,
		quoteNote: quote.quoteNote,
		lines: parseLines(quote.lines),
		charges: parseCharges(quote.charges),
		currency: quote.currency,
		subtotalCents: quote.subtotalCents,
		taxCents: quote.taxCents,
		totalCents: quote.totalCents,
		depositPercent: quote.depositPercent,
		validDays: quote.validDays,
		expiresAt: quote.expiresAt,
		sentAt: quote.sentAt,
		paidAt: quote.paidAt,
		paidOrderId: quote.paidOrderId,
		createdAt: quote.createdAt,
		updatedAt: quote.updatedAt,
	}
}

/** What the guest sees at their link: the lines and amounts, never other people's data. */
export function guestQuoteView(
	quote: CateringQuote,
	deposit: {
		percent: number | null
		depositCents: number
		balanceCents: number
	},
	now: number,
) {
	const payable = quotePayability(
		{ status: quote.status, expiresAtMs: quote.expiresAt },
		now,
	).ok
	return {
		id: quote.id,
		status:
			quote.status === 'sent' &&
			quote.expiresAt != null &&
			quote.expiresAt <= now
				? ('expired' as const)
				: quote.status,
		payable,
		locationId: quote.locationId,
		fulfillment: quote.fulfillment,
		eventAt: quote.eventAt,
		guestCount: quote.guestCount,
		note: quote.quoteNote,
		lines: parseLines(quote.lines).map((line) => ({
			itemName: line.itemName,
			variantNames: line.variantNames ?? [],
			options: line.options.map((option) => option.optionName),
			quantity: line.quantity,
			unitPriceCents: line.unitPriceCents,
			totalCents: line.unitPriceCents * line.quantity,
		})),
		charges: parseCharges(quote.charges).map((charge) => ({
			kind: charge.kind,
			label: charge.label,
			amountCents: charge.amountCents,
		})),
		currency: quote.currency,
		subtotalCents: quote.subtotalCents,
		taxCents: quote.taxCents,
		totalCents: quote.totalCents,
		deposit,
		expiresAt: quote.expiresAt,
	}
}

// ---------------------------------------------------------------------------
// Guest request
// ---------------------------------------------------------------------------

export type GuestRequestResult = { quoteId: string; replayed: boolean }

/**
 * A guest asks for a quote (`POST /catering/quote-requests`). The items are
 * checked against the catering menu with the same engine an order uses, so a
 * request can only name dishes that exist, and the notice, window and cutoffs
 * are the same; the quote itself starts as a draft the restaurant prices.
 */
export async function createGuestQuoteRequest(input: {
	orgId: string
	request: CateringQuoteRequest
	customerId: string | null
	now?: Date
}): Promise<OrderServiceResult<GuestRequestResult>> {
	const { orgId, request } = input
	const now = input.now ?? new Date()
	if (isCateringPublicDisabled()) {
		return orderFailure(
			503,
			'catering_unavailable',
			'Catering is temporarily unavailable. Please try again shortly.',
		)
	}
	const env = await loadCateringEnv(orgId, request.locationId)
	if (!env.ok) return env
	const { context, policy, location } = env.data
	if (!policy) {
		return orderFailure(
			404,
			'catering_disabled',
			'Catering is not available here.',
		)
	}
	if (!policy.quotes) {
		return orderFailure(
			404,
			'catering_quotes_off',
			'This restaurant does not take quote requests.',
		)
	}
	const eventAt = new Date(request.eventAt)
	const timeZone = location.timezone || 'UTC'
	const window = validateCateringEvent({
		settings: policy.settings,
		timeZone,
		eventAt,
		now,
		isOpenAt: isOpenAtFor(location),
	})
	if (!window.ok) {
		return orderFailure(422, window.failure.code, window.failure.message, {
			details: window.failure.details,
		})
	}
	// The same engine an order uses checks the dishes and options on the
	// catering menu. A delivery request is checked as pickup here (the address
	// is verified by the restaurant when it prices the delivery).
	const quoteRequest = restaurantOrderQuoteSchema.safeParse({
		locationId: request.locationId,
		fulfillment: 'pickup',
		paymentMethod: 'online',
		contact: { name: request.contact.name, phone: request.contact.phone },
		tipPercent: 0,
		guestCount: request.guestCount,
		catering: { notes: request.notes },
		scheduledFor: request.eventAt,
		lines: request.lines,
	})
	if (!quoteRequest.success) {
		return orderFailure(400, 'invalid_request', 'Invalid quote request.')
	}
	const priced = priceRestaurantOrder(
		context,
		{
			...quoteRequest.data,
			// The engine checks the head count and fulfillment of the request's
			// own kind below; the check here is only the dishes.
		},
		{ now },
	)
	if (!priced.ok) {
		return orderFailure(
			priced.error.status,
			priced.error.code,
			priced.error.message,
			{ details: priced.error.details },
		)
	}
	const limits = checkCateringLimits({
		settings: policy.settings,
		subtotalCents: priced.result.subtotalCents,
		guestCount: request.guestCount,
		fulfillment: request.fulfillment,
	})
	if (!limits.ok) {
		return orderFailure(422, limits.failure.code, limits.failure.message, {
			details: limits.failure.details,
		})
	}
	const lines = priced.result.lines.map(pricedLineToQuoteLine)
	const totals = totalsFor(lines, [], location)
	const requestHash = sha256(
		JSON.stringify({
			locationId: request.locationId,
			fulfillment: request.fulfillment,
			eventAt: eventAt.toISOString(),
			guestCount: request.guestCount,
			notes: request.notes ?? null,
			contact: request.contact,
			delivery: request.delivery ?? null,
			lines: request.lines,
		}),
	)
	const db = await getTenantDb(orgId)
	const outcome = await runExclusive(orgId, () =>
		retryOnSqliteBusy(async () => {
			const [existing] = await db
				.select()
				.from(cateringQuotes)
				.where(eq(cateringQuotes.idempotencyKey, request.idempotencyKey))
				.limit(1)
			if (existing) {
				return existing.requestHash === requestHash
					? ({ ok: true, quoteId: existing.id, replayed: true } as const)
					: ({ ok: false } as const)
			}
			const [row] = await db
				.insert(cateringQuotes)
				.values({
					locationId: request.locationId,
					customerId: input.customerId,
					status: 'draft',
					source: 'guest',
					locale: request.locale,
					currency: priced.result.currency,
					fulfillment: request.fulfillment,
					eventAt: eventAt.getTime(),
					guestCount: request.guestCount,
					contactName: request.contact.name,
					contactPhone: request.contact.phone,
					contactEmail: request.contact.email,
					delivery: request.delivery ?? null,
					eventNotes: request.notes ?? null,
					lines,
					charges: [],
					subtotalCents: totals.subtotalCents,
					taxCents: totals.taxCents,
					totalCents: totals.totalCents,
					taxRateBp: Math.round((location.taxRate || 0) * 100),
					taxInclusive: location.taxInclusive === true,
					idempotencyKey: request.idempotencyKey,
					requestHash,
					createdAt: now.getTime(),
					updatedAt: now.getTime(),
				})
				.returning()
			return { ok: true, quoteId: row!.id, replayed: false } as const
		}),
	)
	if (!outcome.ok) {
		return orderFailure(
			409,
			'idempotency_conflict',
			'This request was already sent with different details.',
		)
	}
	if (!outcome.replayed) {
		// Ids and a count only: the members are told there is a request, never what it says.
		void onCateringQuoteRequested(orgId, {
			id: outcome.quoteId,
			locationId: request.locationId,
		})
	}
	return {
		ok: true,
		data: { quoteId: outcome.quoteId, replayed: outcome.replayed },
	}
}

// ---------------------------------------------------------------------------
// Operator: create, edit, send, cancel
// ---------------------------------------------------------------------------

type OperatorScope = { locationIds: string[] | null; userId: string }

function inScope(scope: OperatorScope, locationId: string) {
	return scope.locationIds === null || scope.locationIds.includes(locationId)
}

const NOT_FOUND = () => orderFailure(404, 'quote_not_found', 'Quote not found.')

async function loadQuote(
	orgId: string,
	quoteId: string,
): Promise<CateringQuote | null> {
	const db = await getTenantDb(orgId)
	const [row] = await db
		.select()
		.from(cateringQuotes)
		.where(eq(cateringQuotes.id, quoteId))
		.limit(1)
	return row ?? null
}

/** Builds the stored lines from what an operator typed; menu dishes are stamped from the menu. */
function linesFromOperator(
	input: NonNullable<OperatorQuoteWrite['lines']>,
	previous: CateringQuoteLine[],
	menu: ReturnType<typeof cateringMenuItems>,
): { ok: true; lines: CateringQuoteLine[] } | { ok: false; message: string } {
	const lines: CateringQuoteLine[] = []
	for (const line of input) {
		const before = line.lineId
			? previous.find((candidate) => candidate.lineId === line.lineId)
			: undefined
		const dish = line.itemId ? menu.get(line.itemId) : undefined
		if (line.itemId && !dish && !before) {
			return { ok: false, message: 'A dish is not on the catering menu.' }
		}
		const name = line.itemName ?? before?.itemName ?? dish?.name
		if (!name) return { ok: false, message: 'Every line needs a name.' }
		const unit =
			line.unitPriceCents ?? before?.unitPriceCents ?? dish?.priceCents
		if (unit === undefined) {
			return { ok: false, message: 'Every line needs a price.' }
		}
		lines.push({
			lineId: before?.lineId ?? crypto.randomUUID(),
			itemId:
				line.itemId === undefined ? (before?.itemId ?? null) : line.itemId,
			itemName: name,
			variantId: before?.variantId ?? null,
			...(before?.variantNames ? { variantNames: before.variantNames } : {}),
			options: before?.options ?? [],
			quantity: line.quantity,
			unitPriceCents: unit,
			taxable: line.taxable ?? before?.taxable ?? dish?.taxable ?? true,
			instructions:
				line.instructions === undefined
					? (before?.instructions ?? null)
					: line.instructions,
			categoryIds: before?.categoryIds ?? dish?.categoryIds ?? [],
			...(before?.menuId || dish?.menuId
				? { menuId: before?.menuId ?? dish!.menuId }
				: {}),
			...(before?.menuName || dish?.menuName
				? { menuName: before?.menuName ?? dish!.menuName }
				: {}),
			...(before?.categoryId || dish?.categoryId
				? { categoryId: before?.categoryId ?? dish!.categoryId }
				: {}),
			...(before?.categoryName || dish?.categoryName
				? { categoryName: before?.categoryName ?? dish!.categoryName }
				: {}),
		})
	}
	return { ok: true, lines }
}

function chargesFromOperator(
	input: NonNullable<OperatorQuoteWrite['charges']>,
): CateringQuoteCharge[] {
	return input.map((charge) => ({
		chargeId: charge.chargeId ?? crypto.randomUUID(),
		kind: charge.kind,
		label: charge.label,
		amountCents: charge.amountCents,
		taxable: charge.taxable ?? false,
	}))
}

/** A quote an operator starts from scratch (a phone enquiry). */
export async function createOperatorQuote(input: {
	orgId: string
	scope: OperatorScope
	body: OperatorQuoteWrite
	now?: Date
}): Promise<OrderServiceResult<CateringQuote>> {
	const { orgId, body } = input
	const now = (input.now ?? new Date()).getTime()
	if (!body.locationId || !inScope(input.scope, body.locationId)) {
		return orderFailure(404, 'location_not_found', 'Location not found.')
	}
	const env = await loadCateringEnv(orgId, body.locationId)
	if (!env.ok) return env
	if (!env.data.policy) {
		return orderFailure(
			404,
			'catering_disabled',
			'Catering is not available here.',
		)
	}
	const menu = cateringMenuItems(env.data.context)
	const built = linesFromOperator(body.lines ?? [], [], menu)
	if (!built.ok) return orderFailure(400, 'invalid_request', built.message)
	const charges = chargesFromOperator(body.charges ?? [])
	const totals = totalsFor(built.lines, charges, env.data.location)
	const db = await getTenantDb(orgId)
	const [row] = await db
		.insert(cateringQuotes)
		.values({
			locationId: body.locationId,
			status: 'draft',
			source: 'operator',
			currency:
				env.data.location.currency ||
				env.data.context.menu.organization.currency,
			fulfillment: body.fulfillment ?? 'pickup',
			eventAt: body.eventAt ? new Date(body.eventAt).getTime() : null,
			guestCount: body.guestCount ?? null,
			contactName: body.contact?.name ?? '',
			contactPhone: body.contact?.phone ?? '',
			contactEmail: body.contact?.email ?? null,
			delivery: body.delivery ?? null,
			eventNotes: body.notes ?? null,
			quoteNote: body.quoteNote ?? null,
			lines: built.lines,
			charges,
			subtotalCents: totals.subtotalCents,
			taxCents: totals.taxCents,
			totalCents: totals.totalCents,
			taxRateBp: Math.round((env.data.location.taxRate || 0) * 100),
			taxInclusive: env.data.location.taxInclusive === true,
			depositPercent: body.depositPercent ?? null,
			validDays: body.validDays ?? null,
			createdBy: input.scope.userId,
			createdAt: now,
			updatedAt: now,
		})
		.returning()
	return { ok: true, data: row! }
}

const EDITABLE: CateringQuote['status'][] = ['draft', 'sent', 'expired']

/**
 * Edits a quote. A quote that was sent gets a new version (the old link stops
 * working) and goes back to a draft until it is sent again: nobody can pay a
 * price the restaurant has not looked at since the change.
 */
export async function updateOperatorQuote(input: {
	orgId: string
	quoteId: string
	scope: OperatorScope
	body: OperatorQuoteWrite
	now?: Date
}): Promise<OrderServiceResult<CateringQuote>> {
	const { orgId, body } = input
	const now = (input.now ?? new Date()).getTime()
	const quote = await loadQuote(orgId, input.quoteId)
	if (!quote || !inScope(input.scope, quote.locationId)) return NOT_FOUND()
	if (!EDITABLE.includes(quote.status)) {
		return orderFailure(
			409,
			'quote_not_editable',
			quote.status === 'accepted'
				? 'A payment for this quote is in progress.'
				: 'This quote can no longer be edited.',
		)
	}
	if (
		body.expectedVersion !== undefined &&
		body.expectedVersion !== quote.version
	) {
		return orderFailure(409, 'stale_version', 'This quote changed. Reload it.')
	}
	const env = await loadCateringEnv(orgId, quote.locationId)
	if (!env.ok) return env
	const menu = cateringMenuItems(env.data.context)
	const lines = body.lines
		? linesFromOperator(body.lines, parseLines(quote.lines), menu)
		: ({ ok: true, lines: parseLines(quote.lines) } as const)
	if (!lines.ok) return orderFailure(400, 'invalid_request', lines.message)
	const charges = body.charges
		? chargesFromOperator(body.charges)
		: parseCharges(quote.charges)
	const totals = totalsFor(lines.lines, charges, env.data.location)
	const wasSent = quote.sentAt !== null
	const db = await getTenantDb(orgId)
	const [row] = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			db
				.update(cateringQuotes)
				.set({
					fulfillment: body.fulfillment ?? quote.fulfillment,
					eventAt: body.eventAt
						? new Date(body.eventAt).getTime()
						: quote.eventAt,
					guestCount: body.guestCount ?? quote.guestCount,
					contactName: body.contact?.name ?? quote.contactName,
					contactPhone: body.contact?.phone ?? quote.contactPhone,
					contactEmail:
						body.contact?.email !== undefined
							? body.contact.email
							: quote.contactEmail,
					delivery:
						body.delivery === undefined ? quote.delivery : body.delivery,
					eventNotes: body.notes === undefined ? quote.eventNotes : body.notes,
					quoteNote:
						body.quoteNote === undefined ? quote.quoteNote : body.quoteNote,
					lines: lines.lines,
					charges,
					subtotalCents: totals.subtotalCents,
					taxCents: totals.taxCents,
					totalCents: totals.totalCents,
					taxRateBp: Math.round((env.data.location.taxRate || 0) * 100),
					taxInclusive: env.data.location.taxInclusive === true,
					depositPercent:
						body.depositPercent === undefined
							? quote.depositPercent
							: body.depositPercent,
					validDays:
						body.validDays === undefined ? quote.validDays : body.validDays,
					// A sent quote is a new version: the old link is burned.
					...(wasSent
						? { version: quote.version + 1, status: 'draft' as const }
						: {}),
					updatedAt: now,
				})
				.where(
					and(
						eq(cateringQuotes.id, quote.id),
						eq(cateringQuotes.version, quote.version),
						inArray(cateringQuotes.status, EDITABLE),
					),
				)
				.returning(),
		),
	)
	if (!row) {
		return orderFailure(409, 'stale_version', 'This quote changed. Reload it.')
	}
	return { ok: true, data: row }
}

/** Sends (or re-sends) the quote link by email and opens it for payment. */
export async function sendOperatorQuote(input: {
	orgId: string
	quoteId: string
	scope: OperatorScope
	now?: Date
}): Promise<
	OrderServiceResult<{
		quote: CateringQuote
		emailed: boolean
		link: string | null
	}>
> {
	const { orgId } = input
	const now = (input.now ?? new Date()).getTime()
	const quote = await loadQuote(orgId, input.quoteId)
	if (!quote || !inScope(input.scope, quote.locationId)) return NOT_FOUND()
	if (!EDITABLE.includes(quote.status)) {
		return orderFailure(
			409,
			'quote_not_editable',
			'This quote can no longer be sent.',
		)
	}
	const lines = parseLines(quote.lines)
	if (
		lines.length === 0 ||
		quote.totalCents <= 0 ||
		!quote.eventAt ||
		quote.eventAt <= now ||
		!quote.contactEmail ||
		!quote.contactName
	) {
		return orderFailure(
			422,
			'invalid_request',
			'Add the guest, the event time, at least one line and a total before sending.',
		)
	}
	const validDays = quote.validDays ?? CATERING_DEFAULT_QUOTE_VALID_DAYS
	const expiresAt = Math.min(
		now + validDays * 86_400_000,
		// Never payable after the event itself.
		quote.eventAt,
	)
	const db = await getTenantDb(orgId)
	const resend = quote.status === 'sent' || quote.status === 'expired'
	const [row] = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			db
				.update(cateringQuotes)
				.set({
					status: 'sent',
					sentAt: now,
					expiresAt,
					// A re-send of an expired quote opens it again under a new link.
					...(quote.status === 'expired' ? { version: quote.version + 1 } : {}),
					updatedAt: now,
				})
				.where(
					and(
						eq(cateringQuotes.id, quote.id),
						eq(cateringQuotes.version, quote.version),
						inArray(cateringQuotes.status, EDITABLE),
					),
				)
				.returning(),
		),
	)
	if (!row) {
		return orderFailure(409, 'stale_version', 'This quote changed. Reload it.')
	}
	const emailed = await sendCateringQuoteEmail(orgId, row, {
		updated: resend || quote.sentAt !== null,
	})
	return {
		ok: true,
		data: {
			quote: row,
			emailed,
			link: emailed ? null : await linkFor(orgId, row),
		},
	}
}

async function linkFor(orgId: string, quote: CateringQuote) {
	const { getReservationsContext } =
		await import('../lib/reservations-context.ts')
	const context = await getReservationsContext(orgId).catch(() => null)
	return quoteLinkUrl(
		{
			siteOrigin: context?.organization.siteOrigin ?? null,
			defaultLocale: context?.organization.defaultLocale ?? 'en',
		},
		orgId,
		quote,
	)
}

export async function cancelOperatorQuote(input: {
	orgId: string
	quoteId: string
	scope: OperatorScope
	now?: Date
}): Promise<OrderServiceResult<CateringQuote>> {
	const { orgId } = input
	const now = (input.now ?? new Date()).getTime()
	const quote = await loadQuote(orgId, input.quoteId)
	if (!quote || !inScope(input.scope, quote.locationId)) return NOT_FOUND()
	if (!EDITABLE.includes(quote.status)) {
		return orderFailure(
			409,
			'quote_not_editable',
			quote.status === 'accepted'
				? 'A payment for this quote is in progress.'
				: 'This quote can no longer be cancelled.',
		)
	}
	const db = await getTenantDb(orgId)
	const [row] = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			db
				.update(cateringQuotes)
				.set({
					status: 'cancelled',
					// The link is burned with the quote.
					version: quote.version + 1,
					updatedAt: now,
				})
				.where(
					and(
						eq(cateringQuotes.id, quote.id),
						inArray(cateringQuotes.status, EDITABLE),
					),
				)
				.returning(),
		),
	)
	return row ? { ok: true, data: row } : NOT_FOUND()
}

export async function getOperatorQuote(
	orgId: string,
	quoteId: string,
	scope: OperatorScope,
): Promise<OrderServiceResult<CateringQuote>> {
	const quote = await loadQuote(orgId, quoteId)
	if (!quote || !inScope(scope, quote.locationId)) return NOT_FOUND()
	return { ok: true, data: quote }
}

/** Quotes for the Catering tab, newest first (expired ones are marked first). */
export async function listOperatorQuotes(
	orgId: string,
	scope: OperatorScope,
	options: { now?: number; limit?: number } = {},
): Promise<CateringQuote[]> {
	const now = options.now ?? Date.now()
	const db = await getTenantDb(orgId)
	// A sent quote past its expiry reads expired from here on.
	await db
		.update(cateringQuotes)
		.set({ status: 'expired', updatedAt: now })
		.where(
			and(
				eq(cateringQuotes.status, 'sent'),
				lte(cateringQuotes.expiresAt, now),
			),
		)
	const rows = await db
		.select()
		.from(cateringQuotes)
		.orderBy(desc(cateringQuotes.updatedAt))
		.limit(options.limit ?? 200)
	return rows.filter((row) => inScope(scope, row.locationId))
}

// ---------------------------------------------------------------------------
// Guest: read the quote, accept and pay
// ---------------------------------------------------------------------------

type TokenCheck =
	| { ok: true; quote: CateringQuote }
	| { ok: false; failure: ReturnType<typeof orderFailure> }

const INVALID_TOKEN = () =>
	orderFailure(
		403,
		'invalid_quote_token',
		'This quote link is not valid. Ask the restaurant for a new one.',
	)

/**
 * The quote a presented link opens: the MAC must be right for this
 * organization, the id must be the quote asked for and the version must still
 * be the quote's. Every refusal is the same answer.
 */
async function quoteForToken(
	orgId: string,
	quoteId: string,
	token: string,
): Promise<TokenCheck> {
	const parsed = readQuoteToken(orgId, token)
	if (!parsed || parsed.id !== quoteId)
		return { ok: false, failure: INVALID_TOKEN() }
	const quote = await loadQuote(orgId, quoteId)
	if (!quote || quote.version !== parsed.version) {
		return { ok: false, failure: INVALID_TOKEN() }
	}
	return { ok: true, quote }
}

/** Puts an accepted quote back to sent when the order it started will never be paid. */
async function releaseStaleAcceptance(
	orgId: string,
	quote: CateringQuote,
): Promise<CateringQuote> {
	if (quote.status !== 'accepted') return quote
	const db = await getTenantDb(orgId)
	const [live] = await db
		.select({ id: restaurantOrders.id })
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.cateringQuoteId, quote.id),
				or(
					eq(restaurantOrders.paymentStatus, 'pending'),
					eq(restaurantOrders.paymentStatus, 'paid'),
				),
				sql`${restaurantOrders.status} not in ('expired', 'cancelled')`,
			),
		)
		.limit(1)
	if (live) return quote
	const [row] = await db
		.update(cateringQuotes)
		.set({
			status: 'sent',
			paymentSessionId: null,
			paymentProcessor: null,
			updatedAt: Date.now(),
		})
		.where(
			and(
				eq(cateringQuotes.id, quote.id),
				eq(cateringQuotes.status, 'accepted'),
			),
		)
		.returning()
	return row ?? quote
}

function depositFor(
	quote: CateringQuote,
	policy: CateringLocationPolicy | null,
) {
	const percent = quote.depositPercent ?? policy?.settings.deposit.percent ?? 0
	const split = {
		depositCents: quote.totalCents,
		balanceCents: 0,
	}
	if (percent > 0 && percent < 100 && quote.totalCents > 1) {
		const depositCents = Math.min(
			quote.totalCents - 1,
			Math.max(1, Math.round((quote.totalCents * percent) / 100)),
		)
		split.depositCents = depositCents
		split.balanceCents = quote.totalCents - depositCents
	}
	return {
		percent: split.balanceCents > 0 ? percent : null,
		...split,
	}
}

/** `GET /catering/quotes/:id` with `X-Quote-Token`. */
export async function getGuestQuote(input: {
	orgId: string
	quoteId: string
	token: string
	now?: number
}): Promise<OrderServiceResult<ReturnType<typeof guestQuoteView>>> {
	const now = input.now ?? Date.now()
	const checked = await quoteForToken(input.orgId, input.quoteId, input.token)
	if (!checked.ok) return checked.failure
	const quote = await releaseStaleAcceptance(input.orgId, checked.quote)
	// A draft is not open to the guest yet: the restaurant is still working on it.
	if (quote.status === 'draft' || quote.status === 'cancelled') {
		return orderFailure(
			409,
			quote.status === 'cancelled' ? 'quote_cancelled' : 'quote_not_payable',
			quote.status === 'cancelled'
				? 'This quote was cancelled.'
				: 'This quote is not ready yet.',
		)
	}
	const env = await loadCateringEnv(input.orgId, quote.locationId)
	const policy = env.ok ? env.data.policy : null
	return {
		ok: true,
		data: guestQuoteView(quote, depositFor(quote, policy), now),
	}
}

export type QuoteAccept = {
	orderRef: string
	paymentToken: string
	totalCents: number
	currency: string
	holdExpiresAt: string | null
}

/**
 * `POST /catering/quotes/:id/pay` with `X-Quote-Token`: the guest accepts the
 * quote and starts paying. Creates (or reuses) the pending catering order the
 * payment settles; only a sent, unexpired quote of the right version gets here.
 */
export async function acceptQuoteForPayment(input: {
	orgId: string
	quoteId: string
	token: string
	now?: Date
}): Promise<OrderServiceResult<QuoteAccept>> {
	const { orgId } = input
	const now = input.now ?? new Date()
	const checked = await quoteForToken(orgId, input.quoteId, input.token)
	if (!checked.ok) return checked.failure
	const quote = await releaseStaleAcceptance(orgId, checked.quote)
	const payable = quotePayability(
		{ status: quote.status, expiresAtMs: quote.expiresAt },
		now.getTime(),
	)
	if (!payable.ok) {
		const status =
			payable.failure.code === 'quote_expired'
				? 410
				: payable.failure.code === 'quote_cancelled'
					? 410
					: 409
		return orderFailure(status, payable.failure.code, payable.failure.message)
	}
	const env = await loadCateringEnv(orgId, quote.locationId)
	if (!env.ok) return env
	const { context, policy, location } = env.data
	if (!policy) {
		return orderFailure(
			404,
			'catering_disabled',
			'Catering is not available here.',
		)
	}
	if (!context.onlinePayment.enabled || !context.onlinePayment.processor) {
		return orderFailure(
			400,
			'online_payment_disabled',
			'Online payment is not available.',
		)
	}
	const processor = context.onlinePayment.processor
	const db = await getTenantDb(orgId)
	const ref = quoteOrderRef(quote.id)
	const result = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [fresh] = await tx
					.select()
					.from(cateringQuotes)
					.where(eq(cateringQuotes.id, quote.id))
					.limit(1)
				if (!fresh || fresh.version !== quote.version) {
					return { ok: false as const, kind: 'token' as const }
				}
				const existing = await tx
					.select()
					.from(restaurantOrders)
					.where(eq(restaurantOrders.cateringQuoteId, quote.id))
					.orderBy(desc(restaurantOrders.createdAt))
				const live = existing.find(
					(order) =>
						order.paymentStatus === 'pending' &&
						order.status !== 'expired' &&
						order.status !== 'cancelled' &&
						(order.holdExpiresAt?.getTime() ?? 0) > now.getTime(),
				)
				if (existing.some((order) => order.paymentStatus === 'paid')) {
					return { ok: false as const, kind: 'paid' as const }
				}
				if (live) return { ok: true as const, order: live }
				const lines = parseLines(fresh.lines)
				const charges = parseCharges(fresh.charges)
				const deliveryCharge = charges
					.filter((charge) => charge.kind === 'delivery')
					.reduce((sum, charge) => sum + charge.amountCents, 0)
				const lineCharges: CateringQuoteLine[] = charges
					.filter((charge) => charge.kind !== 'delivery')
					.map((charge) => ({
						lineId: charge.chargeId,
						itemId: null,
						itemName: charge.label,
						options: [],
						quantity: 1,
						unitPriceCents: charge.amountCents,
						taxable: charge.taxable,
						instructions: null,
						categoryIds: [],
					}))
				const pricedLines = [...lines, ...lineCharges].map(
					quoteLineToPricedLine,
				)
				const subtotal = pricedLines.reduce(
					(sum, line) => sum + line.totalCents,
					0,
				)
				const orderId = crypto.randomUUID()
				const eventAt = new Date(fresh.eventAt ?? Date.now())
				const collection = cateringCollectionColumns({
					policy,
					totalCents: fresh.totalCents,
					eventAt,
					timeZone: location.timezone || 'UTC',
					guestCount: fresh.guestCount,
					notes: fresh.eventNotes,
					quoteId: fresh.id,
					depositPercentOverride: fresh.depositPercent,
				})
				const delivery = (fresh.delivery ?? null) as {
					address?: string
					city?: string
					unit?: string
					notes?: string
				} | null
				const usedNumbers = new Set<string>()
				const number = await nextOrderNumber(tx, now, usedNumbers, {
					locationId: fresh.locationId,
					timeZone: location.timezone || null,
					orderNumberFormat: null,
				})
				const receiptToken = deriveReceiptToken(orgId, orderId)
				const paymentToken = derivePaymentToken(orgId, orderId)
				const [order] = await tx
					.insert(restaurantOrders)
					.values({
						id: orderId,
						orgId,
						customerId: fresh.customerId,
						number,
						locale: fresh.locale,
						status: 'accepted',
						paymentMethod: 'online',
						paymentStatus: 'pending',
						paymentProcessor: processor,
						fulfillment: fresh.fulfillment,
						locationId: fresh.locationId,
						locationName: location.name,
						contactName: fresh.contactName,
						contactPhone: fresh.contactPhone,
						contactEmail: fresh.contactEmail,
						deliveryAddress: delivery?.address ?? null,
						deliveryCity: delivery?.city ?? null,
						deliveryUnit: delivery?.unit ?? null,
						deliveryNotes: delivery?.notes ?? null,
						scheduledFor: eventAt,
						promisedAt: eventAt,
						locationTimezone: location.timezone || null,
						currency: fresh.currency,
						subtotalCents: subtotal,
						taxCents: fresh.taxCents,
						deliveryFeeCents: deliveryCharge,
						totalCents: fresh.totalCents,
						lines: pricedLines,
						idempotencyKey: `catering-quote:${fresh.id}:${existing.length + 1}`,
						requestHash: sha256(`catering-quote:${fresh.id}:${fresh.version}`),
						receiptTokenHash: sha256(receiptToken),
						paymentTokenHash: sha256(paymentToken),
						holdExpiresAt: new Date(
							now.getTime() + RESTAURANT_ONLINE_HOLD_MINUTES * 60 * 1000,
						),
						...collection,
						createdAt: now,
						updatedAt: now,
					})
					.returning()
				await recordOrderStep(
					tx,
					order!.id,
					{
						step: 'placed',
						actorKind: 'guest',
						actorId: null,
						source: 'guest',
						at: now.getTime(),
					},
					now.getTime(),
				)
				await tx
					.update(cateringQuotes)
					.set({
						status: 'accepted',
						paymentProcessor: processor,
						updatedAt: now.getTime(),
					})
					.where(eq(cateringQuotes.id, fresh.id))
				return { ok: true as const, order: order! }
			}),
		),
	)
	if (!result.ok) {
		return result.kind === 'paid'
			? orderFailure(409, 'quote_not_payable', 'This quote is already paid.')
			: INVALID_TOKEN()
	}
	const order: RestaurantOrder = result.order
	return {
		ok: true,
		data: {
			orderRef: ref,
			paymentToken: derivePaymentToken(orgId, ref),
			totalCents: order.depositCents ?? order.totalCents,
			currency: order.currency,
			holdExpiresAt: order.holdExpiresAt?.toISOString() ?? null,
		},
	}
}

// ---------------------------------------------------------------------------
// The `quote:<id>` payment bridge
// ---------------------------------------------------------------------------

/** The order a `quote:<id>` ref settles: the quote's live pending (or paid) order. */
export async function orderForQuoteRef(
	orgId: string,
	quoteId: string,
): Promise<RestaurantOrder | null> {
	const db = await getTenantDb(orgId)
	const rows = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.cateringQuoteId, quoteId))
		.orderBy(desc(restaurantOrders.createdAt))
	return (
		rows.find((order) => order.paymentStatus === 'paid') ??
		rows.find(
			(order) =>
				order.paymentStatus === 'pending' &&
				order.status !== 'expired' &&
				order.status !== 'cancelled',
		) ??
		rows[0] ??
		null
	)
}

/** After a payment event: a paid quote order closes the quote; a dead one reopens it. */
export async function syncQuoteWithOrder(
	orgId: string,
	quoteId: string,
	order: Pick<
		RestaurantOrder,
		'id' | 'paymentStatus' | 'status' | 'paymentId' | 'paymentSessionId'
	>,
): Promise<void> {
	const db = await getTenantDb(orgId)
	const now = Date.now()
	if (order.paymentStatus === 'paid') {
		await db
			.update(cateringQuotes)
			.set({
				status: 'paid',
				paidAt: now,
				paidOrderId: order.id,
				paymentSessionId: order.paymentSessionId,
				paymentId: order.paymentId,
				paymentEventAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(cateringQuotes.id, quoteId),
					inArray(cateringQuotes.status, ['accepted', 'sent']),
				),
			)
		return
	}
	if (
		order.paymentStatus === 'failed' ||
		order.paymentStatus === 'expired' ||
		order.status === 'cancelled' ||
		order.status === 'expired'
	) {
		await db
			.update(cateringQuotes)
			.set({ status: 'sent', paymentSessionId: null, updatedAt: now })
			.where(
				and(
					eq(cateringQuotes.id, quoteId),
					eq(cateringQuotes.status, 'accepted'),
				),
			)
	}
}

// The App's three calls for a `quote:<id>` ref, answered from the order the
// accept created. The ref has its own payment token (derived from the ref), and
// every answer names the ref, so the App never sees the order's own id.

function refTokenOk(orgId: string, ref: string, presented: string): boolean {
	const expected = derivePaymentToken(orgId, ref)
	return (
		presented.length === expected.length &&
		crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
	)
}

export async function getQuoteRefQuote(
	orgId: string,
	quoteId: string,
	paymentToken: string,
) {
	const ref = quoteOrderRef(quoteId)
	const order = await orderForQuoteRef(orgId, quoteId)
	if (!order) return orderFailure(404, 'order_not_found', 'Order not found.')
	if (!refTokenOk(orgId, ref, paymentToken)) {
		return orderFailure(
			403,
			'invalid_payment_token',
			'This payment link is not valid.',
		)
	}
	const quote = await getOrderQuote(
		orgId,
		order.id,
		derivePaymentToken(orgId, order.id),
	)
	if (!quote.ok) return quote
	return {
		ok: true as const,
		data: {
			...quote.data,
			orderId: ref,
			paymentStatus: order.paymentStatus,
			...(order.paymentSessionId && order.paymentProcessor
				? {
						sessionId: order.paymentSessionId,
						processor: order.paymentProcessor,
					}
				: {}),
		},
	}
}

export async function bindQuoteRefSession(input: {
	orgId: string
	quoteId: string
	sessionId: string
	processor: 'connect' | 'checkout'
}) {
	const order = await orderForQuoteRef(input.orgId, input.quoteId)
	if (!order) return orderFailure(404, 'order_not_found', 'Order not found.')
	const bound = await bindPaymentSession({
		orgId: input.orgId,
		orderId: order.id,
		sessionId: input.sessionId,
		processor: input.processor,
	})
	if (!bound.ok) return bound
	return {
		ok: true as const,
		data: { ...bound.data, orderId: quoteOrderRef(input.quoteId) },
	}
}

export async function applyQuoteRefPaymentEvent(input: {
	orgId: string
	quoteId: string
	sessionId: string
	processor: 'connect' | 'checkout'
	status: 'paid' | 'failed' | 'expired'
	amountCents: number
	currency: string
	paymentId?: string
}) {
	const order = await orderForQuoteRef(input.orgId, input.quoteId)
	if (!order) return orderFailure(404, 'order_not_found', 'Order not found.')
	const applied = await applyPaymentEvent({
		orgId: input.orgId,
		orderId: order.id,
		sessionId: input.sessionId,
		processor: input.processor,
		status: input.status,
		amountCents: input.amountCents,
		currency: input.currency,
		paymentId: input.paymentId,
	})
	if (!applied.ok) return applied
	const fresh = await orderForQuoteRef(input.orgId, input.quoteId)
	if (fresh) await syncQuoteWithOrder(input.orgId, input.quoteId, fresh)
	return {
		ok: true as const,
		data: { ...applied.data, orderId: quoteOrderRef(input.quoteId) },
	}
}
