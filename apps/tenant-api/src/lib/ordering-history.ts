import {
	type OrderingHistory,
	orderingHistorySchema,
} from '@repo/common/ordering-history'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { ENV } from 'varlock/env'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * The scheduled online hours, staff pauses and short-notice closures of every
 * location of an organization over a range (`GET
 * /resources/report/ordering-history`, internal token), as time windows
 * (#176, #405). Windows only come from the control plane; sales and sold-out
 * history stay here. `null` when the control plane cannot be asked, and the
 * report says so instead of showing a made-up figure.
 */

export const ORDERING_HISTORY_TIMEOUT_MS = 6_000

export async function getOrderingHistory(
	orgId: string,
	range: { from: number; to: number },
): Promise<OrderingHistory | null> {
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) return null
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), ORDERING_HISTORY_TIMEOUT_MS)
	try {
		syncEnvFromProcess()
		const base = (ENV.APP_URL || '').replace(/\/$/, '')
		const token = getInternalCommandToken()
		if (!base || token.length < 16) return null
		const response = await fetch(
			`${base}/resources/report/ordering-history?${new URLSearchParams({
				orgId,
				from: String(Math.floor(range.from)),
				to: String(Math.floor(range.to)),
			})}`,
			{
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${token}`,
				},
				redirect: 'error',
				signal: controller.signal,
			},
		)
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined)
			return null
		}
		const parsed = orderingHistorySchema.safeParse(
			await response.json().catch(() => null),
		)
		if (!parsed.success || parsed.data.orgId !== orgId) return null
		return parsed.data
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}
