import { listTenantOrgIds } from '@repo/tenant-db'
import { fanOutOrderAcceptanceTick } from '../services/order-acceptance.ts'
import { syncEnvFromProcess } from './secrets.ts'

/**
 * Sub-hourly acceptance timeout on the Node (OCI) runtime (#107): an
 * in-process interval over every organization on this node that turns down
 * orders still waiting past the deadline the guest was shown (3, 5 or 10
 * minutes), then books cancel refunds still owed. The timeout is a promise to
 * the guest, so unlike the other node intervals it cannot be switched off:
 * `ORDER_ACCEPTANCE_TICK_INTERVAL_SECONDS` sets the period (default 60,
 * minimum 30) and a `0`, negative or unreadable value falls back to the
 * default. `ORDER_MESSAGES_TICK_INTERVAL_SECONDS=0` leaves it running. The
 * hourly cron still reaches the node, and a doubled run is harmless (each
 * order is decided only while it still waits). The Durable Object runtime
 * uses the `orders` alarm module instead.
 */
export const DEFAULT_ORDER_ACCEPTANCE_TICK_INTERVAL_SECONDS = 60
export const MIN_ORDER_ACCEPTANCE_TICK_INTERVAL_SECONDS = 30

export function orderAcceptanceTickIntervalMs(raw: unknown): number {
	const seconds =
		raw === undefined || raw === null || String(raw).trim() === ''
			? Number.NaN
			: Number(raw)
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return DEFAULT_ORDER_ACCEPTANCE_TICK_INTERVAL_SECONDS * 1000
	}
	return Math.max(seconds, MIN_ORDER_ACCEPTANCE_TICK_INTERVAL_SECONDS) * 1000
}

export function startOrderAcceptanceTickInterval(
	options: {
		intervalMs?: number
		run?: () => Promise<unknown>
		setIntervalFn?: typeof setInterval
	} = {},
): { stop: () => void } {
	syncEnvFromProcess()
	const intervalMs =
		options.intervalMs ??
		orderAcceptanceTickIntervalMs(
			typeof process !== 'undefined'
				? process.env.ORDER_ACCEPTANCE_TICK_INTERVAL_SECONDS
				: undefined,
		)
	let running = false
	const run =
		options.run ??
		(async () =>
			fanOutOrderAcceptanceTick({ orgIds: await listTenantOrgIds() }))
	const timer = (options.setIntervalFn ?? setInterval)(() => {
		// A slow pass is never overlapped by the next one.
		if (running) return
		running = true
		run()
			.catch((error) => {
				console.error(
					'Order acceptance tick interval failed',
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
