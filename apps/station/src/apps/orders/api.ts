import {
	posOnlineOrderContactSchema,
	posOnlineOrderDetailSchema,
	posOnlineOrdersFeedSchema,
	posOnlineOrdersSearchSchema,
	type PosOnlineOrderCommand,
	type PosOnlineOrderContact,
	type PosOnlineOrderDetailResponse,
	type PosOnlineOrderRefund,
	type PosOnlineOrdersFeed,
	type PosOnlineOrdersSearch,
	type PosOnlineOrdersSearchQuery,
} from '@repo/common/pos-online-orders'
import { POS_STAFF_SESSION_HEADER } from '@repo/common/pos-orders'
import { type ZodType } from 'zod'
import { noteServerDate } from '~/lib/clock.ts'
import { type PosSettings } from '~/lib/config.ts'
import { serversProblem } from '~/lib/pairing.ts'
import { type Session } from '~/lib/signin.ts'

export class OrdersError extends Error {
	constructor(
		readonly code: string,
		readonly status = 0,
		/** What a refund may still return, when the server says so. */
		readonly refundableCents?: number,
	) {
		super(code)
	}
}

/** What the Orders screen asks of the region (or, in demo mode, of the tab). */
export type OrdersApi = {
	feed: () => Promise<PosOnlineOrdersFeed>
	detail: (id: string) => Promise<PosOnlineOrderDetailResponse>
	command: (
		id: string,
		command: PosOnlineOrderCommand,
	) => Promise<PosOnlineOrderDetailResponse>
	refund: (
		id: string,
		refund: PosOnlineOrderRefund,
		idempotencyKey: string,
	) => Promise<PosOnlineOrderDetailResponse>
	contact: (id: string) => Promise<PosOnlineOrderContact>
	/** Today's and recent orders by number, name or the phone's last digits. */
	search: (query: PosOnlineOrdersSearchQuery) => Promise<PosOnlineOrdersSearch>
}

/**
 * The region's `/pos/online-orders` routes, straight from the tablet: guest
 * data never passes through another server. Nothing here is cached (`no-store`,
 * no IndexedDB) and nothing is retried: after a failed write the screen reads
 * the order back.
 */
export function createOrdersApi(
	settings: PosSettings,
	session: Session | null,
	fetchImpl = fetch,
): OrdersApi {
	async function call<T>(
		method: 'GET' | 'POST',
		path: string,
		schema: ZodType<T>,
		body?: unknown,
		headers: Record<string, string> = {},
	): Promise<T> {
		if (!settings.deviceToken) throw new OrdersError('invalid_device', 401)
		if (!settings.tenantApiUrl || serversProblem([settings.tenantApiUrl]))
			throw new OrdersError('invalid_server', 400)
		const sentAt = Date.now()
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 8_000)
		try {
			const response = await fetchImpl(
				`${settings.tenantApiUrl.replace(/\/+$/, '')}/pos/online-orders${path}`,
				{
					method,
					cache: 'no-store',
					credentials: 'omit',
					headers: {
						Authorization: `Bearer ${settings.deviceToken}`,
						...(body ? { 'Content-Type': 'application/json' } : {}),
						...(session?.serverSession
							? { [POS_STAFF_SESSION_HEADER]: session.serverSession.token }
							: {}),
						...headers,
					},
					...(body ? { body: JSON.stringify(body) } : {}),
					signal: controller.signal,
				},
			)
			noteServerDate(response, sentAt)
			const raw: unknown = await response.json().catch(() => null)
			if (!response.ok) {
				const answer =
					raw && typeof raw === 'object'
						? (raw as { error?: unknown; refundableCents?: unknown })
						: {}
				throw new OrdersError(
					typeof answer.error === 'string'
						? answer.error
						: 'orders_unavailable',
					response.status,
					typeof answer.refundableCents === 'number'
						? answer.refundableCents
						: undefined,
				)
			}
			const parsed = schema.safeParse(raw)
			if (!parsed.success) throw new OrdersError('invalid_response', 502)
			return parsed.data
		} catch (failure) {
			if (failure instanceof OrdersError) throw failure
			throw new OrdersError('connection_lost')
		} finally {
			clearTimeout(timeout)
		}
	}
	const one = (id: string) => `/${encodeURIComponent(id)}`
	return {
		feed: () => call('GET', '', posOnlineOrdersFeedSchema),
		detail: (id) => call('GET', one(id), posOnlineOrderDetailSchema),
		command: (id, command) =>
			call('POST', `${one(id)}/command`, posOnlineOrderDetailSchema, command),
		refund: (id, refund, idempotencyKey) =>
			call('POST', `${one(id)}/refunds`, posOnlineOrderDetailSchema, refund, {
				'Idempotency-Key': idempotencyKey,
			}),
		contact: (id) =>
			call('POST', `${one(id)}/contact`, posOnlineOrderContactSchema, {}),
		search: (query) => {
			const params = new URLSearchParams()
			for (const [key, value] of Object.entries(query))
				if (value !== undefined && value !== '') params.set(key, String(value))
			return call(
				'GET',
				`/search?${params.toString()}`,
				posOnlineOrdersSearchSchema,
			)
		},
	}
}
