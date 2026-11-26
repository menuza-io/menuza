import { and, desc, eq } from 'drizzle-orm'

import {
	isTaxExemptSupportedForCurrency,
	type ReviseOrderLineInput,
	type ReviseOrderRequest,
	type ReviseOrderSuggestedAction,
} from '@repo/common/order-edits'
import { computeOrderAmountDueCents } from '@repo/common/order-pay-links'
import {
	priceRestaurantOrder,
	type PricedOrderLine,
	type RestaurantOrderContext,
	type RestaurantOrderQuoteRequest,
} from '@repo/common/restaurant-orders'
import {
	getTenantDb,
	kdsTickets,
	restaurantOrderRevisions,
	restaurantOrders,
	runTenantTransaction,
	type OrderDiscountSnapshot,
	type RestaurantOrder,
} from '@repo/tenant-db'

import {
	toVerifiedDeliveryQuote,
	verifyDeliveryQuote,
} from '../lib/delivery-quote-token.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import {
	formatMoney,
	normalizeReservationLocale,
} from '../lib/reservations-email.ts'
import { restaurantOrderPaidCents } from './order-pay-links.ts'
import {
	fetchOrderContext,
	orderFailure,
	runExclusive,
	type OrderServiceResult,
} from './order-service.ts'

/**
 * Operator order editing (#162) and tax-exempt orders (#166).
 *
 * Re-prices via `priceRestaurantOrder` (the single pricing engine in
 * `@repo/common/restaurant-orders`), appends every saved edit to
 * `restaurant_order_revisions`, reopens only changed lines on `kds_tickets`,
 * and notifies the guest with an updated receipt when contact email is present.
 */

type Scope = {
	locationIds: string[] | null
	userId: string
	operatorName: string | null
	refundProvider: boolean
}

const CLOSED_STATUSES = new Set(['completed', 'cancelled', 'expired'])

type StoredLine = PricedOrderLine & {
	comped?: boolean
	compReason?: string
}

function lineSignature(line: StoredLine): string {
	const opts = (line.options ?? [])
		.map((o) => `${o.groupId}:${o.optionId}:${o.quantity}`)
		.sort()
		.join(',')
	return `${line.itemId}|${line.variantId ?? ''}|${line.quantity}|${line.instructions ?? ''}|${opts}`
}

function existingLinesToRequest(raw: unknown): ReviseOrderLineInput[] {
	if (!Array.isArray(raw)) return []
	return raw
		.filter((l): l is Record<string, unknown> =>
			Boolean(l && typeof l === 'object'),
		)
		.map((l) => ({
			itemId: String(l.itemId ?? ''),
			variantId: typeof l.variantId === 'string' ? l.variantId : null,
			quantity: Math.max(1, Number(l.quantity ?? 1) || 1),
			instructions: typeof l.instructions === 'string' ? l.instructions : null,
			options: Array.isArray(l.options)
				? l.options.map((o: Record<string, unknown>) => ({
						groupId: String(o.groupId ?? ''),
						optionId: String(o.optionId ?? ''),
						quantity: Math.max(1, Number(o.quantity ?? 1) || 1),
					}))
				: [],
			comped: l.comped === true,
			...(typeof l.compReason === 'string' ? { compReason: l.compReason } : {}),
		}))
}

export type ReviseOrderOutput = {
	order: RestaurantOrder
	revision: number
	replayed: boolean
	dryRun: boolean
	previousTotalCents: number
	newTotalCents: number
	deltaCents: number
	amountDueCents: number
	refundAvailableCents: number
	suggestedAction: ReviseOrderSuggestedAction
	removedDiscounts: string[]
	kdsUpdated: boolean
	receiptSent: boolean
}

export async function reviseOperatorOrder(input: {
	orgId: string
	orderId: string
	scope: Scope
	request: ReviseOrderRequest
	idempotencyKey?: string | null
	/** Optional injected context for tests (otherwise fetched from App). */
	contextOverride?: RestaurantOrderContext | null
	now?: Date
}): Promise<OrderServiceResult<ReviseOrderOutput>> {
	const { orgId, orderId, scope, request } = input
	const now = input.now ?? new Date()
	const db = await getTenantDb(orgId)

	const [initial] = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.id, orderId))
		.limit(1)
	if (
		!initial ||
		(scope.locationIds !== null &&
			!scope.locationIds.includes(initial.locationId))
	) {
		return orderFailure(404, 'order_not_found', 'Order not found.')
	}

	// Idempotent replay check before anything else (non-dryRun only).
	if (!request.dryRun && input.idempotencyKey) {
		const [existingRev] = await db
			.select()
			.from(restaurantOrderRevisions)
			.where(
				and(
					eq(restaurantOrderRevisions.orderId, orderId),
					eq(restaurantOrderRevisions.idempotencyKey, input.idempotencyKey),
				),
			)
			.limit(1)
		if (existingRev) {
			const paid = restaurantOrderPaidCents(initial)
			const amountDueCents = computeOrderAmountDueCents({
				totalCents: initial.totalCents,
				paidCents: paid,
				giftCardCents: initial.giftCardCents,
			})
			const refundAvailableCents = Math.max(
				0,
				paid - initial.refundedCents - initial.totalCents,
			)
			return {
				ok: true,
				data: {
					order: initial,
					revision: existingRev.revision,
					replayed: true,
					dryRun: false,
					previousTotalCents: initial.totalCents,
					newTotalCents: initial.totalCents,
					deltaCents: 0,
					amountDueCents,
					refundAvailableCents,
					suggestedAction:
						refundAvailableCents > 0
							? 'refund'
							: amountDueCents > 0
								? 'pay_link'
								: 'none',
					removedDiscounts: [],
					kdsUpdated: false,
					receiptSent: false,
				},
			}
		}
	}

	// Status & channel guards.
	if (CLOSED_STATUSES.has(initial.status)) {
		return orderFailure(
			409,
			'order_closed',
			'Completed, cancelled, and expired orders cannot be edited.',
		)
	}
	if (initial.tabId) {
		return orderFailure(
			409,
			'order_not_editable',
			'QR tab rounds must be edited through the tab.',
		)
	}
	if (
		initial.attributionSource &&
		['marketplace', 'ubereats', 'doordash', 'grubhub'].includes(
			initial.attributionSource.toLowerCase(),
		)
	) {
		return orderFailure(
			409,
			'order_not_editable',
			'Marketplace orders cannot be edited.',
		)
	}

	// Optimistic concurrency check.
	if (initial.revision !== request.expectedRevision) {
		return orderFailure(
			409,
			'stale_version',
			'This order was updated by someone else. Reload and try again.',
			{ details: { currentRevision: initial.revision } },
		)
	}

	// Comp permission check.
	const hasComp = Boolean(request.lines?.some((l) => l.comped === true))
	if (hasComp && !scope.refundProvider) {
		return orderFailure(
			403,
			'comp_permission_required',
			'Comping an item requires refund permission.',
		)
	}

	// Tax-exempt currency guard (#166).
	if (request.taxExempt !== undefined && request.taxExempt !== null) {
		if (!isTaxExemptSupportedForCurrency(initial.currency)) {
			return orderFailure(
				422,
				'tax_exempt_unavailable_sar',
				'Tax exemption is not available for SAR locations.',
			)
		}
	}

	// Time change guard (at most 1 without manager override).
	const isTimeChange =
		request.scheduledFor !== undefined ||
		request.pickupTime !== undefined ||
		request.pickupDate !== undefined
	if (
		isTimeChange &&
		initial.timeChangeCount >= 1 &&
		!request.managerOverride
	) {
		return orderFailure(
			409,
			'time_change_limit_reached',
			'Only one time change is allowed per order without a manager override.',
		)
	}

	// Resolve next fulfillment and delivery quote if switching to delivery.
	const nextFulfillment =
		request.fulfillment ??
		(initial.fulfillment === 'delivery' ? 'delivery' : 'pickup')
	let verifiedQuotePayload:
		ReturnType<typeof toVerifiedDeliveryQuote> | undefined = undefined

	if (nextFulfillment === 'delivery') {
		if (request.deliveryQuoteToken) {
			const verified = await verifyDeliveryQuote(request.deliveryQuoteToken, {
				orgId,
				locationId: initial.locationId,
				now,
			})
			if (!verified.ok) {
				return orderFailure(
					422,
					'invalid_delivery_quote',
					'A fresh delivery quote for this location is required.',
				)
			}
			verifiedQuotePayload = toVerifiedDeliveryQuote(verified.payload)
		} else if (initial.fulfillment !== 'delivery') {
			return orderFailure(
				422,
				'delivery_quote_required',
				'Switching to delivery requires a valid delivery quote.',
			)
		}
	}

	// Load live menu context for repricing via `priceRestaurantOrder`.
	let context: RestaurantOrderContext | null = input.contextOverride ?? null
	if (!context) {
		const fetched = await fetchOrderContext(
			orgId,
			initial.locationId,
			initial.dropSlug,
		)
		if (fetched.ok) context = fetched.data
	}

	const nextTaxExemptRef =
		request.taxExempt === undefined
			? initial.taxExemptRef
			: request.taxExempt === null
				? null
				: request.taxExempt.ref
	const nextTaxExemptOrg =
		request.taxExempt === undefined
			? initial.taxExemptOrg
			: request.taxExempt === null
				? null
				: request.taxExempt.org
	const isTaxExempt = Boolean(nextTaxExemptRef)

	const nextLineInputs = request.lines ?? existingLinesToRequest(initial.lines)
	let pricedLines: StoredLine[] = Array.isArray(initial.lines)
		? (initial.lines as StoredLine[])
		: []
	let subtotalCents = initial.subtotalCents
	let taxCents = initial.taxCents
	let deliveryFeeCents =
		nextFulfillment === 'pickup' ? 0 : initial.deliveryFeeCents
	let resolvedDeliveryZoneId =
		nextFulfillment === 'pickup' ? null : initial.deliveryZoneId
	let serviceFeeCents = initial.serviceFeeCents
	let serviceFeeTaxCents = initial.serviceFeeTaxCents
	let packagingFeeCents = initial.packagingFeeCents
	let packagingFeeTaxCents = initial.packagingFeeTaxCents
	let discountCents = initial.discountCents
	let deliveryDiscountCents =
		nextFulfillment === 'pickup' ? 0 : initial.deliveryDiscountCents
	let loyaltyDiscountCents = initial.loyaltyDiscountCents
	let nextDiscounts: OrderDiscountSnapshot[] = Array.isArray(initial.discounts)
		? [...initial.discounts]
		: []
	const removedDiscounts: string[] = []

	// Re-price using `priceRestaurantOrder` whenever menu context is available and lines or fulfillment changed.
	if (context && (request.lines || request.fulfillment || isTimeChange)) {
		const priceReq: RestaurantOrderQuoteRequest = {
			locationId: initial.locationId,
			locale: initial.locale,
			fulfillment: nextFulfillment,
			paymentMethod: initial.paymentMethod,
			tipPercent: initial.tipPercent ?? 0,
			lines: nextLineInputs.map((l) => ({
				itemId: l.itemId,
				variantId: l.variantId ?? undefined,
				quantity: l.quantity,
				instructions: l.instructions ?? undefined,
				options: l.options.map((o) => ({
					groupId: o.groupId,
					optionId: o.optionId,
					quantity: o.quantity,
				})),
			})),
			...(nextFulfillment === 'delivery'
				? {
						delivery: {
							address:
								verifiedQuotePayload?.line1 ??
								initial.deliveryAddress ??
								'Address',
							city:
								verifiedQuotePayload?.city ?? initial.deliveryCity ?? undefined,
							unit:
								request.deliveryUnit === undefined
									? (verifiedQuotePayload?.unit ??
										initial.deliveryUnit ??
										undefined)
									: (request.deliveryUnit ?? undefined),
							notes:
								request.deliveryNotes === undefined
									? (initial.deliveryNotes ?? undefined)
									: (request.deliveryNotes ?? undefined),
							...(request.deliveryQuoteToken
								? { quoteToken: request.deliveryQuoteToken }
								: {}),
						},
					}
				: {}),
			...(request.scheduledFor ? { scheduledFor: request.scheduledFor } : {}),
		}
		const priced = priceRestaurantOrder(context, priceReq, {
			now,
			...(verifiedQuotePayload ? { deliveryQuote: verifiedQuotePayload } : {}),
		})
		if (priced.ok) {
			pricedLines = priced.result.lines.map((line, idx) => {
				const inp = nextLineInputs[idx]
				if (inp?.comped) {
					return {
						...line,
						unitPriceCents: 0,
						taxableUnitCents: 0,
						totalCents: 0,
						taxableCents: 0,
						comped: true,
						compReason: inp.compReason,
					}
				}
				return line
			})
			subtotalCents = pricedLines.reduce((sum, l) => sum + l.totalCents, 0)
			// Recompute tax on non-comped taxable lines using location's tax setup
			const loc = context.menu.locations.find(
				(l) => l.id === initial.locationId,
			)
			const taxRate = Math.max(0, loc?.taxRate ?? 0)
			const taxInclusive = loc?.taxInclusive === true
			const taxableSum = pricedLines.reduce((sum, l) => sum + l.taxableCents, 0)
			serviceFeeCents = priced.result.serviceFeeCents
			serviceFeeTaxCents = priced.result.serviceFeeTaxCents
			packagingFeeCents = priced.result.packagingFeeCents
			packagingFeeTaxCents = priced.result.packagingFeeTaxCents
			if (nextFulfillment === 'pickup') {
				deliveryFeeCents = 0
				resolvedDeliveryZoneId = null
			} else {
				deliveryFeeCents = priced.result.deliveryFeeCents
				resolvedDeliveryZoneId =
					priced.result.delivery?.zoneId ?? initial.deliveryZoneId
			}
			// Re-evaluate existing discounts against the new subtotal.
			const keptDiscounts: OrderDiscountSnapshot[] = []
			let recomputedDiscount = 0
			for (const d of nextDiscounts) {
				const discAmt = d.amountMinor ?? 0
				if (subtotalCents <= 0 || discAmt > subtotalCents) {
					removedDiscounts.push(d.name)
				} else {
					keptDiscounts.push(d)
					recomputedDiscount += discAmt
				}
			}
			nextDiscounts = keptDiscounts
			discountCents = Math.min(subtotalCents, recomputedDiscount)
			loyaltyDiscountCents = Math.min(
				Math.max(0, subtotalCents - discountCents),
				initial.loyaltyDiscountCents,
			)
			const taxableAfterDiscount = Math.max(
				0,
				taxableSum - discountCents - loyaltyDiscountCents,
			)
			const lineTax = taxInclusive
				? Math.round((taxableAfterDiscount * taxRate) / (100 + taxRate))
				: Math.round((taxableAfterDiscount * taxRate) / 100)
			taxCents = lineTax + serviceFeeTaxCents + packagingFeeTaxCents
		} else if (
			isTimeChange ||
			request.lines ||
			request.fulfillment === 'delivery'
		) {
			return orderFailure(422, priced.error.code, priced.error.message)
		}
	}

	// Apply tax exemption (#166): zeroes all order tax including delivery/service/packaging fee tax.
	if (isTaxExempt) {
		taxCents = 0
		serviceFeeTaxCents = 0
		packagingFeeTaxCents = 0
	} else if (request.taxExempt === null && initial.taxExemptRef && context) {
		// Un-exempting restores tax from location tax rate.
		const loc = context.menu.locations.find((l) => l.id === initial.locationId)
		const taxRate = Math.max(0, loc?.taxRate ?? 0)
		const taxInclusive = loc?.taxInclusive === true
		const taxableSum = pricedLines.reduce((sum, l) => sum + l.taxableCents, 0)
		const taxableBase = Math.max(
			0,
			taxableSum - discountCents - loyaltyDiscountCents,
		)
		taxCents = taxInclusive
			? Math.round((taxableBase * taxRate) / (100 + taxRate))
			: Math.round((taxableBase * taxRate) / 100)
	}

	const locForInclusive = context?.menu.locations.find(
		(l) => l.id === initial.locationId,
	)
	const isTaxInclusive = locForInclusive?.taxInclusive === true
	const newTotalCents = Math.max(
		0,
		subtotalCents -
			discountCents -
			loyaltyDiscountCents +
			(deliveryFeeCents - deliveryDiscountCents) +
			serviceFeeCents +
			packagingFeeCents +
			(isTaxInclusive ? 0 : taxCents) +
			initial.tipCents,
	)

	const previousTotalCents = initial.totalCents
	const deltaCents = newTotalCents - previousTotalCents
	const paidCents = restaurantOrderPaidCents(initial)
	const amountDueCents = computeOrderAmountDueCents({
		totalCents: newTotalCents,
		paidCents,
		giftCardCents: initial.giftCardCents,
	})
	const refundAvailableCents = Math.max(
		0,
		paidCents - initial.refundedCents - newTotalCents,
	)
	const suggestedAction: ReviseOrderSuggestedAction =
		refundAvailableCents > 0
			? 'refund'
			: amountDueCents > 0
				? 'pay_link'
				: 'none'

	if (request.dryRun) {
		return {
			ok: true,
			data: {
				order: {
					...initial,
					fulfillment: nextFulfillment,
					lines: pricedLines,
					subtotalCents,
					taxCents,
					deliveryFeeCents,
					deliveryDiscountCents,
					discountCents,
					loyaltyDiscountCents,
					discounts: nextDiscounts,
					serviceFeeCents,
					serviceFeeTaxCents,
					packagingFeeCents,
					packagingFeeTaxCents,
					totalCents: newTotalCents,
					taxExemptRef: nextTaxExemptRef,
					taxExemptOrg: nextTaxExemptOrg,
				},
				revision: initial.revision + 1,
				replayed: false,
				dryRun: true,
				previousTotalCents,
				newTotalCents,
				deltaCents,
				amountDueCents,
				refundAvailableCents,
				suggestedAction,
				removedDiscounts,
				kdsUpdated: false,
				receiptSent: false,
			},
		}
	}

	// Persist atomically with optimistic locking on `revision`.
	let kdsUpdated = false
	const persisted = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [fresh] = await tx
					.select()
					.from(restaurantOrders)
					.where(eq(restaurantOrders.id, orderId))
					.limit(1)
				if (!fresh) {
					return orderFailure(404, 'order_not_found', 'Order not found.')
				}
				if (CLOSED_STATUSES.has(fresh.status)) {
					return orderFailure(
						409,
						'order_closed',
						'Completed, cancelled, and expired orders cannot be edited.',
					)
				}
				if (fresh.revision !== request.expectedRevision) {
					return orderFailure(
						409,
						'stale_version',
						'This order was updated by someone else. Reload and try again.',
						{ details: { currentRevision: fresh.revision } },
					)
				}

				const nextRevision = fresh.revision + 1
				const nextScheduledFor =
					request.scheduledFor === undefined
						? fresh.scheduledFor
						: request.scheduledFor === null
							? null
							: new Date(request.scheduledFor)

				const [updated] = await tx
					.update(restaurantOrders)
					.set({
						revision: nextRevision,
						timeChangeCount: isTimeChange
							? fresh.timeChangeCount + 1
							: fresh.timeChangeCount,
						fulfillment: nextFulfillment,
						lines: pricedLines,
						subtotalCents,
						taxCents,
						deliveryFeeCents,
						deliveryDiscountCents,
						discountCents,
						loyaltyDiscountCents,
						discounts: nextDiscounts,
						serviceFeeCents,
						serviceFeeTaxCents,
						packagingFeeCents,
						packagingFeeTaxCents,
						totalCents: newTotalCents,
						taxExemptRef: nextTaxExemptRef,
						taxExemptOrg: nextTaxExemptOrg,
						scheduledFor: nextScheduledFor,
						...(request.pickupWindowId !== undefined
							? { pickupWindowId: request.pickupWindowId }
							: {}),
						...(request.pickupDate !== undefined
							? { pickupDate: request.pickupDate }
							: {}),
						...(request.pickupTime !== undefined
							? { pickupTime: request.pickupTime }
							: {}),
						...(nextFulfillment === 'pickup'
							? {
									deliveryAddress: null,
									deliveryCity: null,
									deliveryUnit: null,
									deliveryNotes: null,
									deliveryZoneId: null,
									deliveryPostalCode: null,
									deliveryLat: null,
									deliveryLng: null,
								}
							: verifiedQuotePayload
								? {
										deliveryAddress: verifiedQuotePayload.line1,
										deliveryCity: verifiedQuotePayload.city,
										deliveryUnit:
											request.deliveryUnit === undefined
												? (verifiedQuotePayload.unit ?? fresh.deliveryUnit)
												: request.deliveryUnit,
										deliveryNotes:
											request.deliveryNotes === undefined
												? fresh.deliveryNotes
												: request.deliveryNotes,
										deliveryZoneId: resolvedDeliveryZoneId,
										deliveryPostalCode: verifiedQuotePayload.postalCode,
										deliveryLat: verifiedQuotePayload.lat,
										deliveryLng: verifiedQuotePayload.lng,
									}
								: {}),
						// Bump balanceVersion if total increased so old pay links don't carry stale totals.
						balanceVersion:
							deltaCents > 0 ? fresh.balanceVersion + 1 : fresh.balanceVersion,
						updatedAt: now,
					})
					.where(
						and(
							eq(restaurantOrders.id, orderId),
							eq(restaurantOrders.revision, request.expectedRevision),
						),
					)
					.returning()

				if (!updated) {
					return orderFailure(
						409,
						'stale_version',
						'This order was updated by someone else.',
					)
				}

				// Append-only revision log.
				await tx.insert(restaurantOrderRevisions).values({
					orderId,
					revision: nextRevision,
					lines: pricedLines,
					totals: {
						subtotalCents,
						taxCents,
						deliveryFeeCents,
						discountCents,
						loyaltyDiscountCents,
						serviceFeeCents,
						packagingFeeCents,
						tipCents: fresh.tipCents,
						totalCents: newTotalCents,
					},
					changes: {
						fulfillmentChanged: fresh.fulfillment !== nextFulfillment,
						timeChanged: isTimeChange,
						taxExemptChanged: fresh.taxExemptRef !== nextTaxExemptRef,
						linesChanged: Boolean(request.lines),
						deltaCents,
						removedDiscounts,
					},
					reason: request.reason ?? null,
					actorId: scope.userId,
					actorName: scope.operatorName,
					idempotencyKey: input.idempotencyKey ?? null,
					createdAt: now,
				})

				// Update KDS ticket: reopen changed lines, keep unchanged lines' progress.
				if (request.lines) {
					const [ticket] = await tx
						.select()
						.from(kdsTickets)
						.where(
							and(
								eq(kdsTickets.source, 'online'),
								eq(kdsTickets.orderId, orderId),
							),
						)
						.limit(1)
					if (ticket) {
						const oldLines = Array.isArray(fresh.lines)
							? (fresh.lines as StoredLine[])
							: []
						const unchangedSigs = new Set(
							oldLines
								.map(lineSignature)
								.filter((sig) =>
									pricedLines.some((nl) => lineSignature(nl) === sig),
								),
						)
						const nextProgress: Record<string, string | number> = {}
						for (const [key, val] of Object.entries(ticket.progress ?? {})) {
							const keep = oldLines.some(
								(ol, idx) =>
									unchangedSigs.has(lineSignature(ol)) &&
									(key === String(idx) ||
										key === `line:${idx}` ||
										key.includes(ol.itemId)),
							)
							if (keep) nextProgress[key] = val
						}
						await tx
							.update(kdsTickets)
							.set({
								version: ticket.version + 1,
								progress: nextProgress,
								completedAt: null,
								updatedAt: now.getTime(),
							})
							.where(
								and(
									eq(kdsTickets.source, 'online'),
									eq(kdsTickets.orderId, orderId),
								),
							)
						kdsUpdated = true
					}
				}

				return { ok: true as const, data: updated }
			}),
		),
	)

	if (!persisted.ok) return persisted

	// Send updated receipt email when the guest has an email.
	let receiptSent = false
	if (persisted.data.contactEmail) {
		const formattedTotal = formatMoney(
			persisted.data.totalCents,
			persisted.data.currency,
			normalizeReservationLocale(persisted.data.locale),
		)
		const taxExemptLine = persisted.data.taxExemptRef
			? `<p>Tax exempt (Certificate #${persisted.data.taxExemptRef})</p>`
			: ''
		await sendTenantEmail({
			to: persisted.data.contactEmail,
			subject: `Updated receipt for order #${persisted.data.number}`,
			html: `<p>Your order #${persisted.data.number} has been updated. New total: ${formattedTotal}.</p>${taxExemptLine}`,
			text: `Your order #${persisted.data.number} has been updated. New total: ${formattedTotal}.${persisted.data.taxExemptRef ? ` Tax exempt (Certificate #${persisted.data.taxExemptRef})` : ''}`,
		})
			.then(() => {
				receiptSent = true
			})
			.catch(() => {})
	}

	return {
		ok: true,
		data: {
			order: persisted.data,
			revision: persisted.data.revision,
			replayed: false,
			dryRun: false,
			previousTotalCents,
			newTotalCents,
			deltaCents,
			amountDueCents,
			refundAvailableCents,
			suggestedAction,
			removedDiscounts,
			kdsUpdated,
			receiptSent,
		},
	}
}

export async function listOrderRevisions(orgId: string, orderId: string) {
	const db = await getTenantDb(orgId)
	const rows = await db
		.select()
		.from(restaurantOrderRevisions)
		.where(eq(restaurantOrderRevisions.orderId, orderId))
		.orderBy(desc(restaurantOrderRevisions.revision))
	return rows.map((row) => ({
		id: row.id,
		revision: row.revision,
		reason: row.reason,
		actorId: row.actorId,
		actorName: row.actorName,
		createdAt: row.createdAt.toISOString(),
		totals: row.totals,
		changes: row.changes,
	}))
}
