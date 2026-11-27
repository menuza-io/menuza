/**
 * Read-only provider payout & balance queries (#168).
 *
 * Stripe destination-charge expansion decision & rate-limit cost:
 * On a Stripe Connect Express account, `balanceTransactions.list({ payout,
 * expand: ['data.source'] }, { stripeAccount })` returns `transfer` rows whose
 * `source` is a Transfer (`tr_...`) carrying `source_transaction` (the platform
 * Charge `ch_...`). Because Stripe caps expansion depth and cannot expand a
 * platform Charge across the connected-account boundary in the same call, we:
 *   1. List balance transactions with `expand: ['data.source']` (1 call / 100 rows).
 *   2. Read `metadata.{type, orgId, orderId}` from the Transfer first.
 *   3. Only when metadata is missing on the Transfer, fetch the platform Charge
 *      (`stripe.charges.retrieve(sourceTransaction)`) — deduplicated per charge
 *      and capped by the 10-minute `PaymentPayoutCache` in App.
 * Worst-case rate-limit cost is 1 + K calls per uncached payout view (where K
 * is the count of distinct charges lacking transfer metadata), amortized to ~0
 * across the 10-minute cache window.
 *
 * Never moves money. Returns opaque provider ids and minor-unit amounts only.
 */

import type Stripe from 'stripe'

export type ProviderBalanceBreakdown = {
	currency: string
	availableCents: number
	inTransitCents: number
	pendingCents: number
	reservedCents: number
}

export type ProviderPayoutSummary = {
	id: string
	provider: 'connect' | 'checkout'
	amountCents: number
	currency: string
	status: 'paid' | 'in_transit' | 'pending' | 'failed' | 'canceled'
	createdAt: string
	arrivalDate: string
}

export type ProviderPayoutOrderKind =
	'restaurant_order' | 'reservation' | 'qr_tab' | 'gift_card'

export type ProviderPayoutTransaction = {
	id: string
	kind: 'payment' | 'refund' | 'dispute' | 'fee' | 'reserve' | 'adjustment'
	createdAt: string
	grossCents: number
	providerFeeCents: number
	platformFeeCents: number
	netCents: number
	currency: string
	orderKind: ProviderPayoutOrderKind | null
	orderId: string | null
	providerPaymentId: string | null
	description: string | null
}

export type ProviderPayoutsSnapshot = {
	provider: 'connect' | 'checkout'
	balance: ProviderBalanceBreakdown
	payouts: ProviderPayoutSummary[]
}

export type ProviderPayoutDetail = {
	payout: ProviderPayoutSummary
	transactions: ProviderPayoutTransaction[]
}

function normalizeOrderKind(
	raw: string | undefined,
): ProviderPayoutOrderKind | null {
	if (
		raw === 'restaurant_order' ||
		raw === 'reservation' ||
		raw === 'qr_tab' ||
		raw === 'gift_card'
	) {
		return raw
	}
	return null
}

function normalizePayoutStatus(
	status: string | null | undefined,
): ProviderPayoutSummary['status'] {
	switch (status) {
		case 'paid':
			return 'paid'
		case 'in_transit':
			return 'in_transit'
		case 'failed':
			return 'failed'
		case 'canceled':
			return 'canceled'
		default:
			return 'pending'
	}
}

export async function fetchStripeConnectPayoutsSnapshot(
	stripe: Stripe,
	connectedAccountId: string,
): Promise<ProviderPayoutsSnapshot> {
	const [balance, payoutsList] = await Promise.all([
		stripe.balance.retrieve({ stripeAccount: connectedAccountId }),
		stripe.payouts.list({ limit: 30 }, { stripeAccount: connectedAccountId }),
	])

	const primaryCurrency = (
		balance.available[0]?.currency ??
		balance.pending[0]?.currency ??
		payoutsList.data[0]?.currency ??
		'usd'
	).toUpperCase()

	const sumByCurrency = (
		entries?: Array<{ amount: number; currency: string }>,
	) =>
		(entries ?? [])
			.filter((e) => e.currency.toUpperCase() === primaryCurrency)
			.reduce((acc, e) => acc + e.amount, 0)

	const inTransitCents = payoutsList.data
		.filter(
			(p) =>
				p.status === 'in_transit' &&
				p.currency.toUpperCase() === primaryCurrency,
		)
		.reduce((acc, p) => acc + p.amount, 0)

	return {
		provider: 'connect',
		balance: {
			currency: primaryCurrency,
			availableCents: sumByCurrency(balance.available),
			inTransitCents,
			pendingCents: sumByCurrency(balance.pending),
			reservedCents: sumByCurrency(balance.connect_reserved),
		},
		payouts: payoutsList.data.map((p) => ({
			id: p.id,
			provider: 'connect' as const,
			amountCents: p.amount,
			currency: p.currency.toUpperCase(),
			status: normalizePayoutStatus(p.status),
			createdAt: new Date(p.created * 1000).toISOString(),
			arrivalDate: new Date(p.arrival_date * 1000).toISOString(),
		})),
	}
}

export async function fetchStripeConnectPayoutDetail(
	stripe: Stripe,
	connectedAccountId: string,
	payoutId: string,
): Promise<ProviderPayoutDetail> {
	const [payout, txns] = await Promise.all([
		stripe.payouts.retrieve(payoutId, { stripeAccount: connectedAccountId }),
		stripe.balanceTransactions.list(
			{ payout: payoutId, limit: 100, expand: ['data.source'] },
			{ stripeAccount: connectedAccountId },
		),
	])

	const transactions: ProviderPayoutTransaction[] = []
	for (const bt of txns.data) {
		if (bt.type === 'payout') continue
		const src =
			bt.source && typeof bt.source === 'object'
				? (bt.source as {
						id?: string
						metadata?: Record<string, string>
						source_transaction?:
							string | { id?: string; metadata?: Record<string, string> }
						payment_intent?: string | { id?: string }
					})
				: null

		let metadata = src?.metadata ?? {}
		if (!metadata.orderId && src?.source_transaction) {
			if (typeof src.source_transaction === 'string') {
				try {
					const charge = await stripe.charges.retrieve(src.source_transaction)
					metadata = charge.metadata ?? {}
				} catch {
					// Keep empty metadata; transaction surfaces as unmatched.
				}
			} else if (src.source_transaction.metadata) {
				metadata = src.source_transaction.metadata
			}
		}

		const kind: ProviderPayoutTransaction['kind'] =
			bt.type === 'refund' || bt.type === 'payment_refund'
				? 'refund'
				: bt.type === 'adjustment' &&
					  (bt.description ?? '').toLowerCase().includes('dispute')
					? 'dispute'
					: bt.type === 'reserve_transaction'
						? 'reserve'
						: bt.type === 'stripe_fee' || bt.type === 'application_fee'
							? 'fee'
							: 'payment'

		let providerFeeCents = 0
		let platformFeeCents = 0
		for (const detail of bt.fee_details ?? []) {
			if (detail.type === 'application_fee') {
				platformFeeCents += detail.amount
			} else {
				providerFeeCents += detail.amount
			}
		}
		if (providerFeeCents === 0 && platformFeeCents === 0 && bt.fee > 0) {
			providerFeeCents = bt.fee
		}

		const paymentId =
			typeof src?.payment_intent === 'string'
				? src.payment_intent
				: (src?.payment_intent?.id ?? src?.id ?? null)

		transactions.push({
			id: bt.id,
			kind,
			createdAt: new Date(bt.created * 1000).toISOString(),
			grossCents: bt.amount,
			providerFeeCents,
			platformFeeCents,
			netCents: bt.net,
			currency: bt.currency.toUpperCase(),
			orderKind: normalizeOrderKind(metadata.type),
			orderId: metadata.orderId ?? null,
			providerPaymentId: paymentId,
			description: bt.description ?? null,
		})
	}

	return {
		payout: {
			id: payout.id,
			provider: 'connect',
			amountCents: payout.amount,
			currency: payout.currency.toUpperCase(),
			status: normalizePayoutStatus(payout.status),
			createdAt: new Date(payout.created * 1000).toISOString(),
			arrivalDate: new Date(payout.arrival_date * 1000).toISOString(),
		},
		transactions,
	}
}

/**
 * Deterministic mock-provider payouts fixture (#168) for `PAYMENTS_MOCK` /
 * `MOCKS=true` and unit tests — includes a payment, a refund, a dispute,
 * separate provider and platform fees, and an unmatched transaction.
 */
export function buildMockPayoutsSnapshot(input: {
	provider: 'connect' | 'checkout'
	currency?: string
}): ProviderPayoutsSnapshot {
	const currency = (input.currency ?? 'USD').toUpperCase()
	return {
		provider: input.provider,
		balance: {
			currency,
			availableCents: 18450,
			inTransitCents: 12190,
			pendingCents: 6400,
			reservedCents: 1500,
		},
		payouts: [
			{
				id: `po_mock_${input.provider}_1`,
				provider: input.provider,
				amountCents: 12190,
				currency,
				status: 'paid',
				createdAt: '2026-11-24T08:00:00.000Z',
				arrivalDate: '2026-11-26T08:00:00.000Z',
			},
			{
				id: `po_mock_${input.provider}_2`,
				provider: input.provider,
				amountCents: 8950,
				currency,
				status: 'in_transit',
				createdAt: '2026-11-26T08:00:00.000Z',
				arrivalDate: '2026-11-28T08:00:00.000Z',
			},
		],
	}
}

export function buildMockPayoutDetail(input: {
	payoutId: string
	provider: 'connect' | 'checkout'
	currency?: string
	sampleOrderIds?: string[]
}): ProviderPayoutDetail {
	const currency = (input.currency ?? 'USD').toUpperCase()
	const ord1 = input.sampleOrderIds?.[0] ?? 'ord_mock_1001'
	const ord2 = input.sampleOrderIds?.[1] ?? 'ord_mock_1002'
	// Payment 1: gross 10000, provider fee 320, platform fee 200 -> net 9480
	// Payment 2: gross 6000, provider fee 204, platform fee 120 -> net 5676
	// Unmatched payment: gross 2000, provider fee 88, platform fee 40 -> net 1872
	// Refund on ord2: gross -2000, fees 0 -> net -2000
	// Dispute debit: gross -2838, fees 0 -> net -2838
	// Total net = 9480 + 5676 + 1872 - 2000 - 2838 = 12190 (exact match!)
	return {
		payout: {
			id: input.payoutId,
			provider: input.provider,
			amountCents: 12190,
			currency,
			status: 'paid',
			createdAt: '2026-11-24T08:00:00.000Z',
			arrivalDate: '2026-11-26T08:00:00.000Z',
		},
		transactions: [
			{
				id: 'txn_mock_pay_1',
				kind: 'payment',
				createdAt: '2026-11-23T18:10:00.000Z',
				grossCents: 10000,
				providerFeeCents: 320,
				platformFeeCents: 200,
				netCents: 9480,
				currency,
				orderKind: 'restaurant_order',
				orderId: ord1,
				providerPaymentId: 'pi_mock_1001',
				description: 'Restaurant order payment',
			},
			{
				id: 'txn_mock_pay_2',
				kind: 'payment',
				createdAt: '2026-11-23T19:20:00.000Z',
				grossCents: 6000,
				providerFeeCents: 204,
				platformFeeCents: 120,
				netCents: 5676,
				currency,
				orderKind: 'restaurant_order',
				orderId: ord2,
				providerPaymentId: 'pi_mock_1002',
				description: 'Restaurant order payment',
			},
			{
				id: 'txn_mock_unmatched_1',
				kind: 'payment',
				createdAt: '2026-11-23T20:00:00.000Z',
				grossCents: 2000,
				providerFeeCents: 88,
				platformFeeCents: 40,
				netCents: 1872,
				currency,
				orderKind: null,
				orderId: null,
				providerPaymentId: 'pi_mock_unmatched',
				description: 'Unlinked provider charge',
			},
			{
				id: 'txn_mock_refund_1',
				kind: 'refund',
				createdAt: '2026-11-23T21:00:00.000Z',
				grossCents: -2000,
				providerFeeCents: 0,
				platformFeeCents: 0,
				netCents: -2000,
				currency,
				orderKind: 'restaurant_order',
				orderId: ord2,
				providerPaymentId: 're_mock_1',
				description: 'Partial refund',
			},
			{
				id: 'txn_mock_dispute_1',
				kind: 'dispute',
				createdAt: '2026-11-23T22:00:00.000Z',
				grossCents: -2838,
				providerFeeCents: 0,
				platformFeeCents: 0,
				netCents: -2838,
				currency,
				orderKind: 'restaurant_order',
				orderId: ord1,
				providerPaymentId: 'dp_mock_1',
				description: 'Chargeback dispute debit',
			},
		],
	}
}
