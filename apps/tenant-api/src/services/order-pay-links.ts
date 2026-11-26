import crypto from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'

import { balanceOrderRef } from '@repo/common/catering'
import { buildLink } from '@repo/common/links'
import {
	computeOrderAmountDueCents,
	ORDER_PAY_LINK_TOKEN_PURPOSE,
	ORDER_PAY_LINK_TTL_MS,
	parseOrderPayLinkToken,
	serializeOrderPayLinkToken,
	type OrderPayLinkChannel,
	type OrderPayLinkKind,
	type OrderPayLinkLineSummary,
	type OrderPayLinkStart,
	type OrderPayLinkSummary,
	type ParsedOrderPayLinkToken,
} from '@repo/common/order-pay-links'
import { sendSms } from '@repo/sms'
import {
	cateringPayments,
	getTenantDb,
	posOrders,
	posPayments,
	restaurantOrders,
	runTenantTransaction,
	type CateringPayment,
	type RestaurantOrder,
} from '@repo/tenant-db'

import { getNodeRegion } from '../lib/region.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import {
	formatMoney,
	normalizeReservationLocale,
} from '../lib/reservations-email.ts'
import { hmacHash, timingSafeEqualString } from '../lib/secrets.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import {
	derivePaymentToken,
	orderFailure,
	runExclusive,
	type OrderServiceResult,
} from './order-service.ts'

/**
 * Pay-what-you-owe links for restaurant orders and Station phone orders (#163).
 *
 * Reuses `catering_payments` (with `kind: 'pay_link'`) for online orders,
 * `pos_payments` for Station phone orders, and the existing `bal:<orderId>`
 * payment bridge. Capability tokens live in the URL fragment only, expire after
 * 7 days or when the order closes, and contain no guest contact details.
 */

type Scope = { locationIds: string[] | null; userId: string }

function inScope(scope: Scope, locationId: string) {
	return scope.locationIds === null || scope.locationIds.includes(locationId)
}

function payLinkMessage(
	orgId: string,
	kind: OrderPayLinkKind,
	orderId: string,
	version: number,
	expiresAtSec: number,
): string {
	return `${ORDER_PAY_LINK_TOKEN_PURPOSE}:${orgId}:${kind}:${orderId}:${version}:${expiresAtSec}`
}

export function deriveOrderPayLinkToken(
	orgId: string,
	kind: OrderPayLinkKind,
	orderId: string,
	version: number,
	nowMs = Date.now(),
): { token: string; expiresAt: number } {
	const expiresAt = nowMs + ORDER_PAY_LINK_TTL_MS
	const expiresAtSec = Math.floor(expiresAt / 1000)
	const mac = hmacHash(
		payLinkMessage(orgId, kind, orderId, version, expiresAtSec),
	)
	return {
		token: serializeOrderPayLinkToken({
			kind,
			orderId,
			version,
			expiresAtSec,
			mac,
		}),
		expiresAt: expiresAtSec * 1000,
	}
}

export function readOrderPayLinkToken(
	orgId: string,
	raw: unknown,
	nowMs = Date.now(),
):
	| { ok: true; parsed: ParsedOrderPayLinkToken }
	| { ok: false; reason: 'invalid' | 'expired' } {
	const parsed = parseOrderPayLinkToken(raw)
	if (!parsed) return { ok: false, reason: 'invalid' }
	const expected = hmacHash(
		payLinkMessage(
			orgId,
			parsed.kind,
			parsed.orderId,
			parsed.version,
			parsed.expiresAtSec,
		),
	)
	if (!timingSafeEqualString(parsed.mac, expected)) {
		return { ok: false, reason: 'invalid' }
	}
	if (nowMs > parsed.expiresAtSec * 1000) {
		return { ok: false, reason: 'expired' }
	}
	return { ok: true, parsed }
}

export function restaurantOrderPaidCents(order: RestaurantOrder): number {
	if (order.paidCents !== null && order.paidCents !== undefined) {
		return Math.max(0, order.paidCents)
	}
	return order.paymentStatus === 'paid' ? order.totalCents : 0
}

export function restaurantOrderAmountDueCents(order: RestaurantOrder): number {
	return computeOrderAmountDueCents({
		totalCents: order.totalCents,
		paidCents: restaurantOrderPaidCents(order),
		giftCardCents: order.giftCardCents,
	})
}

async function posOrderPaidCents(
	orgId: string,
	orderId: string,
): Promise<number> {
	const db = await getTenantDb(orgId)
	const rows = await db
		.select()
		.from(posPayments)
		.where(eq(posPayments.orderId, orderId))
	let net = 0
	for (const row of rows) {
		net += row.kind === 'refund' ? -row.amountCents : row.amountCents
	}
	return Math.max(0, net)
}

function summarizeOnlineLines(raw: unknown): OrderPayLinkLineSummary[] {
	if (!Array.isArray(raw)) return []
	return raw
		.filter((l): l is Record<string, unknown> =>
			Boolean(l && typeof l === 'object'),
		)
		.map((l) => ({
			name: String(l.itemName ?? l.name ?? 'Item'),
			quantity: Number(l.quantity ?? 1) || 1,
			totalCents: Number(l.totalCents ?? 0) || 0,
		}))
}

function summarizePosLines(raw: unknown): OrderPayLinkLineSummary[] {
	if (!Array.isArray(raw)) return []
	return raw
		.filter((l): l is Record<string, unknown> =>
			Boolean(l && typeof l === 'object'),
		)
		.map((l) => {
			const qty = Number(l.quantity ?? 1) || 1
			const base = Number(l.baseCents ?? 0) || 0
			const opts = Array.isArray(l.options)
				? l.options.reduce(
						(sum: number, o: Record<string, unknown>) =>
							sum +
							(Number(o.unitCents ?? 0) || 0) * (Number(o.quantity ?? 1) || 1),
						0,
					)
				: 0
			return {
				name: String(l.name ?? 'Item'),
				quantity: qty,
				totalCents: (base + opts) * qty,
			}
		})
}

function isOnlineOrderClosed(status: string): boolean {
	return (
		status === 'cancelled' || status === 'expired' || status === 'completed'
	)
}

async function buildPayLinkUrl(
	orgId: string,
	locale: string,
	token: string,
): Promise<{ url: string | null; restaurantName: string }> {
	const context = await getReservationsContext(orgId).catch(() => null)
	const siteOrigin = context?.organization.siteOrigin ?? null
	const defaultLocale = context?.organization.defaultLocale ?? 'en'
	const localePrefix =
		locale !== defaultLocale && locale !== 'en' ? `/${locale}` : ''
	const url = buildLink(
		'order_pay',
		{ pay: token },
		{ origin: siteOrigin, localePrefix },
	)
	const restaurantName =
		context?.organization.emailTheme?.organizationName ||
		context?.organization.name ||
		'Restaurant'
	return { url, restaurantName }
}

async function deliverPayLink(input: {
	orgId: string
	channel: OrderPayLinkChannel
	phone: string | null
	email: string | null
	url: string
	orderNumber: string
	amountDueCents: number
	currency: string
	locale: string
	restaurantName: string
}): Promise<{
	sent: boolean
	error?: { status: number; code: string; message: string }
}> {
	if (input.channel === 'copy') return { sent: false }
	const formattedAmount = formatMoney(
		input.amountDueCents,
		input.currency,
		normalizeReservationLocale(input.locale),
	)
	if (input.channel === 'sms') {
		if (getNodeRegion() !== 'us') {
			return {
				sent: false,
				error: {
					status: 422,
					code: 'sms_unavailable_in_region',
					message: 'SMS pay links are only available on US nodes.',
				},
			}
		}
		if (!input.phone) {
			return {
				sent: false,
				error: {
					status: 422,
					code: 'missing_phone',
					message: 'No phone number is available for this order.',
				},
			}
		}
		await sendSms({
			to: input.phone,
			message: `${input.restaurantName}: Pay ${formattedAmount} for order #${input.orderNumber}: ${input.url}`,
		})
		return { sent: true }
	}
	if (!input.email) {
		return {
			sent: false,
			error: {
				status: 422,
				code: 'missing_email',
				message: 'No email address is available for this order.',
			},
		}
	}
	await sendTenantEmail({
		to: input.email,
		subject: `Pay for order #${input.orderNumber} (${formattedAmount})`,
		html: `<p>Please use the link below to pay ${formattedAmount} for order #${input.orderNumber} at ${input.restaurantName}:</p><p><a href="${input.url}">${input.url}</a></p>`,
		text: `Pay ${formattedAmount} for order #${input.orderNumber} at ${input.restaurantName}: ${input.url}`,
	})
	return { sent: true }
}

export type CreatedPayLink = {
	url: string
	token: string
	amountDueCents: number
	currency: string
	expiresAt: number
	channel: OrderPayLinkChannel
	sent: boolean
}

/** `POST /operator/orders/:id/pay-link` */
export async function createOperatorOrderPayLink(input: {
	orgId: string
	orderId: string
	scope: Scope
	channel: OrderPayLinkChannel
	recipient?: string
	now?: number
}): Promise<OrderServiceResult<CreatedPayLink>> {
	const now = input.now ?? Date.now()
	const db = await getTenantDb(input.orgId)
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.id, input.orderId))
		.limit(1)
	if (!order || !inScope(input.scope, order.locationId)) {
		return orderFailure(404, 'order_not_found', 'Order not found.')
	}
	if (order.status === 'cancelled' || order.status === 'expired') {
		return orderFailure(
			409,
			'order_cancelled',
			'Cancelled orders cannot be paid.',
		)
	}
	if (order.status === 'completed') {
		return orderFailure(409, 'order_closed', 'Completed orders cannot be paid.')
	}
	const paidCents = restaurantOrderPaidCents(order)
	const amountDueCents = restaurantOrderAmountDueCents(order)
	if (amountDueCents <= 0) {
		return orderFailure(
			409,
			paidCents > 0 || order.paymentStatus === 'paid'
				? 'order_fully_paid'
				: 'nothing_due',
			paidCents > 0 || order.paymentStatus === 'paid'
				? 'This order is already paid in full.'
				: 'There is nothing due on this order.',
		)
	}
	const { token, expiresAt } = deriveOrderPayLinkToken(
		input.orgId,
		'o',
		order.id,
		order.balanceVersion,
		now,
	)
	const { url, restaurantName } = await buildPayLinkUrl(
		input.orgId,
		order.locale,
		token,
	)
	const finalUrl =
		url ??
		buildLink(
			'order_pay',
			{ pay: token },
			{ origin: 'https://pay.local' },
		)?.slice('https://pay.local'.length) ??
		''
	const delivery = await deliverPayLink({
		orgId: input.orgId,
		channel: input.channel,
		phone:
			input.channel === 'sms' ? (input.recipient ?? order.contactPhone) : null,
		email:
			input.channel === 'email'
				? (input.recipient ?? order.contactEmail)
				: null,
		url: finalUrl,
		orderNumber: order.number,
		amountDueCents,
		currency: order.currency,
		locale: order.locale,
		restaurantName,
	})
	if (delivery.error) {
		return orderFailure(
			delivery.error.status as 422,
			delivery.error.code,
			delivery.error.message,
		)
	}
	return {
		ok: true,
		data: {
			url: finalUrl,
			token,
			amountDueCents,
			currency: order.currency,
			expiresAt,
			channel: input.channel,
			sent: delivery.sent,
		},
	}
}

/** `POST /pos/orders/:id/pay-link` (Station phone orders) */
export async function createPosOrderPayLink(input: {
	orgId: string
	orderId: string
	locationId: string
	channel: OrderPayLinkChannel
	recipient?: string
	now?: number
}): Promise<OrderServiceResult<CreatedPayLink>> {
	const now = input.now ?? Date.now()
	const db = await getTenantDb(input.orgId)
	const [order] = await db
		.select()
		.from(posOrders)
		.where(eq(posOrders.id, input.orderId))
		.limit(1)
	if (!order || order.locationId !== input.locationId) {
		return orderFailure(404, 'order_not_found', 'Order not found.')
	}
	if (order.status === 'void' || order.status === 'refunded') {
		return orderFailure(
			409,
			'order_cancelled',
			'Cancelled orders cannot be paid.',
		)
	}
	const paidCents = await posOrderPaidCents(input.orgId, order.id)
	const amountDueCents = computeOrderAmountDueCents({
		totalCents: order.totalCents,
		paidCents,
	})
	if (order.status === 'paid' || amountDueCents <= 0) {
		return orderFailure(
			409,
			order.status === 'paid' || paidCents > 0
				? 'order_fully_paid'
				: 'nothing_due',
			order.status === 'paid' || paidCents > 0
				? 'This order is already paid in full.'
				: 'There is nothing due on this order.',
		)
	}
	const { token, expiresAt } = deriveOrderPayLinkToken(
		input.orgId,
		'p',
		order.id,
		order.balanceVersion,
		now,
	)
	const { url, restaurantName } = await buildPayLinkUrl(
		input.orgId,
		'en',
		token,
	)
	const finalUrl =
		url ??
		buildLink(
			'order_pay',
			{ pay: token },
			{ origin: 'https://pay.local' },
		)?.slice('https://pay.local'.length) ??
		''
	const delivery = await deliverPayLink({
		orgId: input.orgId,
		channel: input.channel,
		phone:
			input.channel === 'sms' ? (input.recipient ?? order.customerPhone) : null,
		email: input.channel === 'email' ? (input.recipient ?? null) : null,
		url: finalUrl,
		orderNumber: order.number,
		amountDueCents,
		currency: order.currency,
		locale: 'en',
		restaurantName,
	})
	if (delivery.error) {
		return orderFailure(
			delivery.error.status as 422,
			delivery.error.code,
			delivery.error.message,
		)
	}
	return {
		ok: true,
		data: {
			url: finalUrl,
			token,
			amountDueCents,
			currency: order.currency,
			expiresAt,
			channel: input.channel,
			sent: delivery.sent,
		},
	}
}

/** `GET /orders/pay` with `X-Pay-Link-Token` */
export async function getPublicPayLinkSummary(input: {
	orgId: string
	token: string
	now?: number
}): Promise<OrderServiceResult<OrderPayLinkSummary>> {
	const now = input.now ?? Date.now()
	const verified = readOrderPayLinkToken(input.orgId, input.token, now)
	if (!verified.ok) {
		return verified.reason === 'expired'
			? orderFailure(410, 'pay_link_expired', 'This payment link has expired.')
			: orderFailure(403, 'invalid_pay_link', 'This payment link is not valid.')
	}
	const { kind, orderId, version, expiresAtSec } = verified.parsed
	const db = await getTenantDb(input.orgId)
	if (kind === 'o') {
		const [order] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, orderId))
			.limit(1)
		if (!order || order.balanceVersion !== version) {
			return orderFailure(
				403,
				'invalid_pay_link',
				'This payment link is not valid.',
			)
		}
		if (order.status === 'cancelled' || order.status === 'expired') {
			return orderFailure(409, 'order_cancelled', 'This order was cancelled.')
		}
		const paidCents = restaurantOrderPaidCents(order)
		const amountDueCents = restaurantOrderAmountDueCents(order)
		const payable =
			amountDueCents > 0 &&
			!isOnlineOrderClosed(order.status) &&
			order.disputeStatus !== 'open'
		return {
			ok: true,
			data: {
				kind: 'o',
				orderId: order.id,
				number: order.number,
				locationName: order.locationName,
				currency: order.currency,
				totalCents: order.totalCents,
				paidCents,
				amountDueCents,
				status: order.status,
				paymentStatus:
					amountDueCents === 0 &&
					(paidCents > 0 || order.paymentStatus === 'paid')
						? 'paid'
						: paidCents > 0
							? 'partly_paid'
							: order.paymentStatus,
				payable,
				expiresAt: expiresAtSec * 1000,
				lines: summarizeOnlineLines(order.lines),
			},
		}
	}
	const [order] = await db
		.select()
		.from(posOrders)
		.where(eq(posOrders.id, orderId))
		.limit(1)
	if (!order || order.balanceVersion !== version) {
		return orderFailure(
			403,
			'invalid_pay_link',
			'This payment link is not valid.',
		)
	}
	if (order.status === 'void' || order.status === 'refunded') {
		return orderFailure(409, 'order_cancelled', 'This order was cancelled.')
	}
	const paidCents = await posOrderPaidCents(input.orgId, order.id)
	const amountDueCents = computeOrderAmountDueCents({
		totalCents: order.totalCents,
		paidCents,
	})
	const payable = amountDueCents > 0 && order.status === 'open'
	return {
		ok: true,
		data: {
			kind: 'p',
			orderId: order.id,
			number: order.number,
			locationName: order.locationName ?? '',
			currency: order.currency,
			totalCents: order.totalCents,
			paidCents,
			amountDueCents,
			status: order.status,
			paymentStatus:
				order.status === 'paid' || amountDueCents === 0
					? 'paid'
					: paidCents > 0
						? 'partly_paid'
						: 'unpaid',
			payable,
			expiresAt: expiresAtSec * 1000,
			lines: summarizePosLines(order.lines),
		},
	}
}

/** `POST /orders/pay` with `X-Pay-Link-Token`: prepares hosted checkout via `bal:<orderId>`. */
export async function startPublicPayLinkPayment(input: {
	orgId: string
	token: string
	now?: number
}): Promise<OrderServiceResult<OrderPayLinkStart>> {
	const now = input.now ?? Date.now()
	const verified = readOrderPayLinkToken(input.orgId, input.token, now)
	if (!verified.ok) {
		return verified.reason === 'expired'
			? orderFailure(410, 'pay_link_expired', 'This payment link has expired.')
			: orderFailure(403, 'invalid_pay_link', 'This payment link is not valid.')
	}
	const { kind, orderId, version } = verified.parsed
	const db = await getTenantDb(input.orgId)
	if (kind === 'o') {
		return runExclusive(input.orgId, () =>
			retryOnSqliteBusy(() =>
				runTenantTransaction(db, async (tx) => {
					const [order] = await tx
						.select()
						.from(restaurantOrders)
						.where(eq(restaurantOrders.id, orderId))
						.limit(1)
					if (!order || order.balanceVersion !== version) {
						return orderFailure(
							403,
							'invalid_pay_link',
							'This payment link is not valid.',
						)
					}
					if (order.status === 'cancelled' || order.status === 'expired') {
						return orderFailure(
							409,
							'order_cancelled',
							'Cancelled orders cannot be paid.',
						)
					}
					if (order.status === 'completed') {
						return orderFailure(
							409,
							'order_closed',
							'Completed orders cannot be paid.',
						)
					}
					if (order.disputeStatus === 'open') {
						return orderFailure(
							409,
							'payment_disputed',
							'This order cannot take a payment right now.',
						)
					}
					const paidCents = restaurantOrderPaidCents(order)
					const amountDueCents = restaurantOrderAmountDueCents(order)
					if (amountDueCents <= 0) {
						return orderFailure(
							409,
							paidCents > 0 || order.paymentStatus === 'paid'
								? 'order_fully_paid'
								: 'nothing_due',
							paidCents > 0 || order.paymentStatus === 'paid'
								? 'This order is already paid in full.'
								: 'There is nothing due on this order.',
						)
					}
					const [pending] = await tx
						.select()
						.from(cateringPayments)
						.where(
							and(
								eq(cateringPayments.orderId, order.id),
								eq(cateringPayments.status, 'pending'),
								eq(cateringPayments.balanceVersion, order.balanceVersion),
							),
						)
						.limit(1)
					if (pending && pending.amountCents !== amountDueCents) {
						await tx
							.update(cateringPayments)
							.set({ status: 'expired', updatedAt: now })
							.where(eq(cateringPayments.id, pending.id))
					}
					if (!pending || pending.amountCents !== amountDueCents) {
						await tx.insert(cateringPayments).values({
							orderId: order.id,
							kind: 'pay_link',
							amountCents: amountDueCents,
							currency: order.currency,
							status: 'pending',
							processor: order.paymentProcessor ?? null,
							balanceVersion: order.balanceVersion,
							createdAt: now,
							updatedAt: now,
						})
					}
					const ref = balanceOrderRef(order.id)
					return {
						ok: true as const,
						data: {
							orderRef: ref,
							paymentToken: derivePaymentToken(input.orgId, ref),
							amountDueCents,
							currency: order.currency,
						},
					}
				}),
			),
		)
	}

	// POS phone order ('p')
	const [order] = await db
		.select()
		.from(posOrders)
		.where(eq(posOrders.id, orderId))
		.limit(1)
	if (!order || order.balanceVersion !== version) {
		return orderFailure(
			403,
			'invalid_pay_link',
			'This payment link is not valid.',
		)
	}
	if (order.status === 'void' || order.status === 'refunded') {
		return orderFailure(
			409,
			'order_cancelled',
			'Cancelled orders cannot be paid.',
		)
	}
	const paidCents = await posOrderPaidCents(input.orgId, order.id)
	const amountDueCents = computeOrderAmountDueCents({
		totalCents: order.totalCents,
		paidCents,
	})
	if (order.status === 'paid' || amountDueCents <= 0) {
		return orderFailure(
			409,
			order.status === 'paid' || paidCents > 0
				? 'order_fully_paid'
				: 'nothing_due',
			order.status === 'paid' || paidCents > 0
				? 'This order is already paid in full.'
				: 'There is nothing due on this order.',
		)
	}
	const ref = balanceOrderRef(order.id)
	return {
		ok: true,
		data: {
			orderRef: ref,
			paymentToken: derivePaymentToken(input.orgId, ref),
			amountDueCents,
			currency: order.currency,
		},
	}
}

// ---------------------------------------------------------------------------
// `bal:<orderId>` payment bridge for non-catering online orders & POS orders
// ---------------------------------------------------------------------------

async function pendingOrderPayment(
	orgId: string,
	orderId: string,
): Promise<CateringPayment | null> {
	const db = await getTenantDb(orgId)
	const [row] = await db
		.select()
		.from(cateringPayments)
		.where(
			and(
				eq(cateringPayments.orderId, orderId),
				eq(cateringPayments.status, 'pending'),
			),
		)
		.orderBy(desc(cateringPayments.createdAt))
		.limit(1)
	return row ?? null
}

function checkPaymentToken(
	orgId: string,
	ref: string,
	presented: string,
): boolean {
	const expected = derivePaymentToken(orgId, ref)
	return (
		presented.length === expected.length &&
		crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
	)
}

export async function getOrderPayLinkQuote(
	orgId: string,
	orderId: string,
	paymentToken: string,
) {
	const ref = balanceOrderRef(orderId)
	if (!checkPaymentToken(orgId, ref, paymentToken)) {
		return orderFailure(
			403,
			'invalid_payment_token',
			'This payment link is not valid.',
		)
	}
	const db = await getTenantDb(orgId)
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.id, orderId))
		.limit(1)
	if (order) {
		const payment = await pendingOrderPayment(orgId, orderId)
		const paidCents = restaurantOrderPaidCents(order)
		const due = restaurantOrderAmountDueCents(order)
		const fullyPaid =
			due <= 0 && (paidCents > 0 || order.paymentStatus === 'paid')
		return {
			ok: true as const,
			data: {
				orgId,
				orderId: ref,
				totalCents: payment?.amountCents ?? due,
				currency: order.currency,
				holdExpiresAt: null,
				status:
					order.status === 'cancelled' || order.status === 'expired'
						? 'cancelled'
						: 'accepted',
				paymentStatus: fullyPaid ? 'paid' : payment ? 'pending' : 'unknown',
				payPage: 'order' as const,
				...(payment?.sessionId && payment.processor
					? { sessionId: payment.sessionId, processor: payment.processor }
					: {}),
			},
		}
	}
	const [posOrder] = await db
		.select()
		.from(posOrders)
		.where(eq(posOrders.id, orderId))
		.limit(1)
	if (!posOrder) {
		return orderFailure(404, 'order_not_found', 'Order not found.')
	}
	const paidCents = await posOrderPaidCents(orgId, posOrder.id)
	const due = computeOrderAmountDueCents({
		totalCents: posOrder.totalCents,
		paidCents,
	})
	return {
		ok: true as const,
		data: {
			orgId,
			orderId: ref,
			totalCents: due,
			currency: posOrder.currency,
			holdExpiresAt: null,
			status:
				posOrder.status === 'void' || posOrder.status === 'refunded'
					? 'cancelled'
					: 'accepted',
			paymentStatus:
				posOrder.status === 'paid' || due <= 0 ? 'paid' : 'pending',
			payPage: 'order' as const,
		},
	}
}

export async function bindOrderPayLinkSession(input: {
	orgId: string
	orderId: string
	sessionId: string
	processor: 'connect' | 'checkout'
}) {
	const { orgId } = input
	const db = await getTenantDb(orgId)
	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [order] = await tx
					.select()
					.from(restaurantOrders)
					.where(eq(restaurantOrders.id, input.orderId))
					.limit(1)
				if (order) {
					const [payment] = await tx
						.select()
						.from(cateringPayments)
						.where(
							and(
								eq(cateringPayments.orderId, order.id),
								eq(cateringPayments.status, 'pending'),
							),
						)
						.orderBy(desc(cateringPayments.createdAt))
						.limit(1)
					if (!payment) {
						return orderFailure(
							409,
							'nothing_due',
							'There is no payment waiting to start.',
						)
					}
					if (payment.sessionId && payment.sessionId !== input.sessionId) {
						return orderFailure(
							409,
							'session_conflict',
							'This payment already has a payment session.',
						)
					}
					if (!payment.sessionId) {
						await tx
							.update(cateringPayments)
							.set({
								sessionId: input.sessionId,
								processor: input.processor,
								updatedAt: Date.now(),
							})
							.where(eq(cateringPayments.id, payment.id))
					}
					return {
						ok: true as const,
						data: {
							orgId,
							orderId: balanceOrderRef(order.id),
							sessionId: input.sessionId,
							status: order.status,
							paymentStatus: 'pending',
						},
					}
				}
				const [posOrder] = await tx
					.select()
					.from(posOrders)
					.where(eq(posOrders.id, input.orderId))
					.limit(1)
				if (!posOrder) {
					return orderFailure(404, 'order_not_found', 'Order not found.')
				}
				if (posOrder.status !== 'open') {
					return orderFailure(
						409,
						posOrder.status === 'paid' ? 'order_fully_paid' : 'order_cancelled',
						'This order cannot take a payment.',
					)
				}
				return {
					ok: true as const,
					data: {
						orgId,
						orderId: balanceOrderRef(posOrder.id),
						sessionId: input.sessionId,
						status: posOrder.status,
						paymentStatus: 'pending',
					},
				}
			}),
		),
	)
}

export async function applyOrderPayLinkPaymentEvent(input: {
	orgId: string
	orderId: string
	sessionId: string
	processor: 'connect' | 'checkout'
	status: 'paid' | 'failed' | 'expired'
	amountCents: number
	currency: string
	paymentId?: string
}) {
	const { orgId } = input
	const db = await getTenantDb(orgId)
	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const now = Date.now()
				const [order] = await tx
					.select()
					.from(restaurantOrders)
					.where(eq(restaurantOrders.id, input.orderId))
					.limit(1)
				if (order) {
					const [payment] = await tx
						.select()
						.from(cateringPayments)
						.where(eq(cateringPayments.sessionId, input.sessionId))
						.limit(1)
					if (!payment || payment.orderId !== order.id) {
						return orderFailure(
							403,
							'session_mismatch',
							'This payment event does not match a payment session.',
						)
					}
					const reply = (paymentStatus: string) => ({
						ok: true as const,
						data: {
							orgId,
							orderId: balanceOrderRef(order.id),
							sessionId: input.sessionId,
							status: order.status,
							paymentStatus,
						},
					})
					if (payment.status === 'paid' || payment.status === 'review') {
						return reply('paid')
					}
					if (payment.processor && payment.processor !== input.processor) {
						return orderFailure(
							409,
							'processor_mismatch',
							'This payment event does not match the bound payment processor.',
						)
					}
					if (payment.amountCents !== input.amountCents) {
						return orderFailure(
							422,
							'amount_mismatch',
							'The payment amount does not match what is due.',
						)
					}
					if (order.currency.toLowerCase() !== input.currency.toLowerCase()) {
						return orderFailure(
							422,
							'currency_mismatch',
							'The payment currency does not match this order.',
						)
					}
					if (input.status !== 'paid') {
						await tx
							.update(cateringPayments)
							.set({
								status: input.status === 'expired' ? 'expired' : 'failed',
								updatedAt: now,
							})
							.where(eq(cateringPayments.id, payment.id))
						return reply('failed')
					}
					const alreadyPaid = restaurantOrderPaidCents(order)
					const dueBefore = restaurantOrderAmountDueCents(order)
					const stale =
						order.status === 'cancelled' ||
						order.status === 'expired' ||
						dueBefore <= 0 ||
						payment.balanceVersion !== order.balanceVersion
					await tx
						.update(cateringPayments)
						.set({
							status: stale ? 'review' : 'paid',
							paymentId: input.paymentId ?? payment.paymentId,
							paidAt: now,
							updatedAt: now,
						})
						.where(eq(cateringPayments.id, payment.id))
					const newPaid = alreadyPaid + payment.amountCents
					const newDue = computeOrderAmountDueCents({
						totalCents: order.totalCents,
						paidCents: newPaid,
						giftCardCents: order.giftCardCents,
					})
					const nowPaidInFull = newDue === 0 && !stale
					await tx
						.update(restaurantOrders)
						.set({
							paidCents: newPaid,
							balancePaidCents: order.balancePaidCents + payment.amountCents,
							paymentStatus: nowPaidInFull ? 'paid' : order.paymentStatus,
							paymentProcessor: order.paymentProcessor ?? input.processor,
							paidAt: nowPaidInFull
								? (order.paidAt ?? new Date(now))
								: order.paidAt,
							balanceState: nowPaidInFull ? 'paid' : order.balanceState,
							updatedAt: new Date(now),
						})
						.where(eq(restaurantOrders.id, order.id))
					return reply('paid')
				}

				// POS phone order ('p')
				const [posOrder] = await tx
					.select()
					.from(posOrders)
					.where(eq(posOrders.id, input.orderId))
					.limit(1)
				if (!posOrder) {
					return orderFailure(404, 'order_not_found', 'Order not found.')
				}
				if (posOrder.currency.toLowerCase() !== input.currency.toLowerCase()) {
					return orderFailure(
						422,
						'currency_mismatch',
						'The payment currency does not match this order.',
					)
				}
				const reply = (paymentStatus: string, status = posOrder.status) => ({
					ok: true as const,
					data: {
						orgId,
						orderId: balanceOrderRef(posOrder.id),
						sessionId: input.sessionId,
						status,
						paymentStatus,
					},
				})
				if (input.status !== 'paid') return reply('failed')
				const paymentRowId = input.paymentId || `paylink-${input.sessionId}`
				const [existing] = await tx
					.select()
					.from(posPayments)
					.where(eq(posPayments.id, paymentRowId))
					.limit(1)
				if (existing) return reply('paid', posOrder.status)
				const existingPayments = await tx
					.select()
					.from(posPayments)
					.where(eq(posPayments.orderId, posOrder.id))
				let paidBefore = 0
				for (const p of existingPayments) {
					paidBefore += p.kind === 'refund' ? -p.amountCents : p.amountCents
				}
				const dueBefore = Math.max(
					0,
					posOrder.totalCents - Math.max(0, paidBefore),
				)
				if (input.amountCents > dueBefore && dueBefore > 0) {
					return orderFailure(
						422,
						'amount_mismatch',
						'The payment amount exceeds what is due.',
					)
				}
				await tx.insert(posPayments).values({
					id: paymentRowId,
					orderId: posOrder.id,
					deviceId: posOrder.deviceId,
					kind: 'payment',
					method: 'card',
					amountCents: input.amountCents,
					tenderedCents: input.amountCents,
					reference: `pay_link:${input.sessionId}`.slice(0, 64),
					paidAt: now,
					receivedAt: now,
				})
				const newPaid = Math.max(0, paidBefore) + input.amountCents
				const nextStatus =
					newPaid >= posOrder.totalCents && posOrder.status === 'open'
						? 'paid'
						: posOrder.status
				if (nextStatus === 'paid') {
					await tx
						.update(posOrders)
						.set({
							status: 'paid',
							paidAt: now,
							updatedAt: now,
						})
						.where(eq(posOrders.id, posOrder.id))
				}
				return reply('paid', nextStatus)
			}),
		),
	)
}
