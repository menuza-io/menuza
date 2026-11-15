import {
	orderRefundExecuteRequestSchema,
	type OrderRefundExecuteRequest,
} from '@repo/common/restaurant-orders'
import { ENV } from 'varlock/env'

import { runInBackground } from './background.ts'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Region → App kick after the region booked a provider refund itself (#80:
 * a cancel with a refund, Station Orders, later guest self-cancel and
 * acceptance): `POST <APP_URL>/resources/orders/refund-execute` with the
 * internal token and `{ orgId, refundId }` (ids only, strict schema). The App
 * reads the refund back from `/api/orders/refunds-pending`, calls the
 * provider with a key derived from the refund id and reports
 * `/api/orders/refund-status`.
 *
 * Best effort: it runs after the write committed, in the background (kept
 * alive with the platform's `waitUntil`), never throws and never delays the
 * caller's response. A lost kick is picked up by the App's reconcile job,
 * which re-drives every pending refund. Logs carry ids and a code only.
 */

export const ORDER_REFUND_EXECUTE_PATH = '/resources/orders/refund-execute'

export type OrderRefundKickOutcome =
	{ status: 'sent' } | { status: 'failed'; code: string }

function appUrl(): string {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

export async function postOrderRefundExecute(
	request: OrderRefundExecuteRequest,
): Promise<OrderRefundKickOutcome> {
	const parsed = orderRefundExecuteRequestSchema.safeParse(request)
	if (!parsed.success) return { status: 'failed', code: 'invalid_request' }
	const base = appUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16) {
		return { status: 'failed', code: 'not_configured' }
	}
	try {
		const response = await fetch(`${base}${ORDER_REFUND_EXECUTE_PATH}`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(parsed.data),
			redirect: 'error',
			signal: AbortSignal.timeout(8_000),
		})
		void response.body?.cancel().catch(() => undefined)
		return response.ok
			? { status: 'sent' }
			: { status: 'failed', code: `http_${response.status}` }
	} catch {
		return { status: 'failed', code: 'network_error' }
	}
}

type Poster = (
	request: OrderRefundExecuteRequest,
) => Promise<OrderRefundKickOutcome>

let posterOverride: Poster | null = null

/** Tests only: replace the HTTP call (null restores it). */
export function setOrderRefundKickForTest(poster: Poster | null): void {
	posterOverride = poster
}

const inFlight = new Set<Promise<void>>()

/** Tests: waits for kicks started by `kickOrderRefundExecute`. */
export async function orderRefundKicksIdle(): Promise<void> {
	while (inFlight.size > 0) await Promise.all(inFlight)
}

/** Starts the kick for each refund in the background. Never throws. */
export function kickOrderRefundExecute(
	orgId: string,
	refundIds: readonly string[],
): void {
	for (const refundId of refundIds) {
		const work = (async () => {
			try {
				const outcome = await (posterOverride ?? postOrderRefundExecute)({
					orgId,
					refundId,
				})
				if (outcome.status === 'failed') {
					console.warn('Order refund kick not delivered', {
						orgId,
						refundId,
						code: outcome.code,
					})
				}
			} catch (error) {
				console.warn('Order refund kick failed', {
					orgId,
					refundId,
					error: error instanceof Error ? error.name : 'unknown',
				})
			}
		})().finally(() => {
			inFlight.delete(work)
		})
		inFlight.add(work)
		runInBackground(work)
	}
}
