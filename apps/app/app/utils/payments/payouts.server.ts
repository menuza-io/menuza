import { and, db, eq, PaymentPayoutCache } from '@repo/database'
import {
	buildMockPayoutDetail,
	buildMockPayoutsSnapshot,
	fetchStripeConnectPayoutDetail,
	fetchStripeConnectPayoutsSnapshot,
	type ProviderPayoutDetail,
	type ProviderPayoutsSnapshot,
} from '@repo/payments'
import { getPaymentsMockStatus } from '#app/utils/payments-mock/gate.server.ts'
import { stripe } from '#app/utils/payments.server.ts'

export const PAYOUT_CACHE_TTL_MS = 10 * 60 * 1000

async function readCache<T>(
	organizationId: string,
	provider: 'connect' | 'checkout',
	cacheKey: string,
	nowMs: number,
): Promise<{ data: T; fetchedAt: Date } | null> {
	const [row] = await db
		.select()
		.from(PaymentPayoutCache)
		.where(
			and(
				eq(PaymentPayoutCache.organizationId, organizationId),
				eq(PaymentPayoutCache.provider, provider),
				eq(PaymentPayoutCache.cacheKey, cacheKey),
			),
		)
		.limit(1)
	if (!row) return null
	if (nowMs - row.fetchedAt.getTime() > PAYOUT_CACHE_TTL_MS) return null
	try {
		return { data: JSON.parse(row.json) as T, fetchedAt: row.fetchedAt }
	} catch {
		return null
	}
}

async function writeCache(
	organizationId: string,
	provider: 'connect' | 'checkout',
	cacheKey: string,
	data: unknown,
	now: Date,
): Promise<void> {
	const json = JSON.stringify(data)
	await db
		.insert(PaymentPayoutCache)
		.values({
			organizationId,
			provider,
			cacheKey,
			json,
			fetchedAt: now,
		})
		.onConflictDoUpdate({
			target: [
				PaymentPayoutCache.organizationId,
				PaymentPayoutCache.provider,
				PaymentPayoutCache.cacheKey,
			],
			set: { json, fetchedAt: now },
		})
}

export async function getOrganizationPayoutsSnapshot(input: {
	organizationId: string
	provider: 'connect' | 'checkout'
	connectedAccountId: string | null
	currency?: string
	forceRefresh?: boolean
	nowMs?: number
}): Promise<{
	snapshot: ProviderPayoutsSnapshot
	fetchedAt: string
	cached: boolean
}> {
	const nowMs = input.nowMs ?? Date.now()
	if (!input.forceRefresh) {
		const cached = await readCache<ProviderPayoutsSnapshot>(
			input.organizationId,
			input.provider,
			'summary',
			nowMs,
		)
		if (cached) {
			return {
				snapshot: cached.data,
				fetchedAt: cached.fetchedAt.toISOString(),
				cached: true,
			}
		}
	}

	let snapshot: ProviderPayoutsSnapshot
	if (
		getPaymentsMockStatus().enabled ||
		!input.connectedAccountId ||
		input.provider === 'checkout'
	) {
		snapshot = buildMockPayoutsSnapshot({
			provider: input.provider,
			currency: input.currency,
		})
	} else {
		snapshot = await fetchStripeConnectPayoutsSnapshot(
			stripe,
			input.connectedAccountId,
		)
	}

	const now = new Date(nowMs)
	await writeCache(
		input.organizationId,
		input.provider,
		'summary',
		snapshot,
		now,
	)
	return { snapshot, fetchedAt: now.toISOString(), cached: false }
}

export async function getOrganizationPayoutDetail(input: {
	organizationId: string
	provider: 'connect' | 'checkout'
	connectedAccountId: string | null
	payoutId: string
	currency?: string
	forceRefresh?: boolean
	nowMs?: number
}): Promise<{
	detail: ProviderPayoutDetail
	fetchedAt: string
	cached: boolean
}> {
	const nowMs = input.nowMs ?? Date.now()
	const cacheKey = `payout:${input.payoutId}`
	if (!input.forceRefresh) {
		const cached = await readCache<ProviderPayoutDetail>(
			input.organizationId,
			input.provider,
			cacheKey,
			nowMs,
		)
		if (cached) {
			return {
				detail: cached.data,
				fetchedAt: cached.fetchedAt.toISOString(),
				cached: true,
			}
		}
	}

	let detail: ProviderPayoutDetail
	if (
		getPaymentsMockStatus().enabled ||
		!input.connectedAccountId ||
		input.provider === 'checkout' ||
		input.payoutId.startsWith('po_mock_')
	) {
		detail = buildMockPayoutDetail({
			payoutId: input.payoutId,
			provider: input.provider,
			currency: input.currency,
		})
	} else {
		detail = await fetchStripeConnectPayoutDetail(
			stripe,
			input.connectedAccountId,
			input.payoutId,
		)
	}

	const now = new Date(nowMs)
	await writeCache(input.organizationId, input.provider, cacheKey, detail, now)
	return { detail, fetchedAt: now.toISOString(), cached: false }
}
