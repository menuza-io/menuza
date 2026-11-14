import { listTenantOrgIds } from '@repo/tenant-db'
import {
	fanOutOrderMessagesTick,
	runOrderMessagesTickLogged,
} from '../services/order-message-send.ts'
import { syncEnvFromProcess } from './secrets.ts'

/**
 * Sub-hourly guest order messages tick on the Node (OCI) runtime: an
 * in-process interval over every organization on this node that retries
 * receipts and status messages whose send failed (an organization with no
 * queued row costs one indexed read). The hourly cron still reaches the node,
 * and a doubled run is harmless (each row is claimed before it is sent).
 * `ORDER_MESSAGES_TICK_INTERVAL_SECONDS` sets the period (default 120, minimum
 * 60, `0` off). The Durable Object runtime uses alarms instead.
 */
export const DEFAULT_ORDER_MESSAGES_TICK_INTERVAL_SECONDS = 120
export const MIN_ORDER_MESSAGES_TICK_INTERVAL_SECONDS = 60

export function orderMessagesTickIntervalMs(raw: unknown): number | null {
	if (raw === undefined || raw === null || String(raw).trim() === '') {
		return DEFAULT_ORDER_MESSAGES_TICK_INTERVAL_SECONDS * 1000
	}
	const seconds = Number(raw)
	if (!Number.isFinite(seconds) || seconds <= 0) return null
	return Math.max(seconds, MIN_ORDER_MESSAGES_TICK_INTERVAL_SECONDS) * 1000
}

export function startOrderMessagesTickInterval(
	options: {
		intervalMs?: number | null
		run?: () => Promise<unknown>
		setIntervalFn?: typeof setInterval
	} = {},
): { stop: () => void } | null {
	syncEnvFromProcess()
	const intervalMs =
		options.intervalMs === undefined
			? orderMessagesTickIntervalMs(
					typeof process !== 'undefined'
						? process.env.ORDER_MESSAGES_TICK_INTERVAL_SECONDS
						: undefined,
				)
			: options.intervalMs
	if (intervalMs === null) return null
	let running = false
	const run =
		options.run ??
		(async () =>
			fanOutOrderMessagesTick({
				orgIds: await listTenantOrgIds(),
				run: (orgId) => runOrderMessagesTickLogged(orgId),
			}))
	const timer = (options.setIntervalFn ?? setInterval)(() => {
		// A slow pass is never overlapped by the next one.
		if (running) return
		running = true
		run()
			.catch((error) => {
				console.error(
					'Order messages tick interval failed',
					error instanceof Error ? error.name : 'unknown',
				)
			})
			.finally(() => {
				running = false
			})
	}, intervalMs)
	;(timer as { unref?: () => void }).unref?.()
	return { stop: () => clearInterval(timer) }
}
