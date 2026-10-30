import { listTenantOrgIds } from '@repo/tenant-db'
import {
	fanOutLoyaltyTick,
	runLoyaltyTickLogged,
} from '../services/loyalty-tick-service.ts'
import { syncEnvFromProcess } from './secrets.ts'

/**
 * Sub-hourly loyalty tick on the Node (OCI) runtime: an in-process interval
 * over every organization on this node. The hourly cron still reaches the
 * node as a safety net, and a doubled run is harmless (every task is
 * idempotent). `LOYALTY_TICK_INTERVAL_SECONDS` sets the period (default 120,
 * minimum 60, `0` off). The Durable Object runtime uses alarms instead.
 */
export const DEFAULT_LOYALTY_TICK_INTERVAL_SECONDS = 120
export const MIN_LOYALTY_TICK_INTERVAL_SECONDS = 60

export function loyaltyTickIntervalMs(raw: unknown): number | null {
	if (raw === undefined || raw === null || String(raw).trim() === '') {
		return DEFAULT_LOYALTY_TICK_INTERVAL_SECONDS * 1000
	}
	const seconds = Number(raw)
	if (!Number.isFinite(seconds) || seconds <= 0) return null
	return Math.max(seconds, MIN_LOYALTY_TICK_INTERVAL_SECONDS) * 1000
}

export function startLoyaltyTickInterval(
	options: {
		intervalMs?: number | null
		run?: () => Promise<unknown>
		setIntervalFn?: typeof setInterval
	} = {},
): { stop: () => void } | null {
	syncEnvFromProcess()
	const intervalMs =
		options.intervalMs === undefined
			? loyaltyTickIntervalMs(
					typeof process !== 'undefined'
						? process.env.LOYALTY_TICK_INTERVAL_SECONDS
						: undefined,
				)
			: options.intervalMs
	if (intervalMs === null) return null
	let running = false
	const run =
		options.run ??
		(async () =>
			fanOutLoyaltyTick({
				orgIds: await listTenantOrgIds(),
				run: (orgId) => runLoyaltyTickLogged(orgId),
			}))
	const timer = (options.setIntervalFn ?? setInterval)(() => {
		// A slow pass is never overlapped by the next one.
		if (running) return
		running = true
		run()
			.catch((error) => {
				console.error(
					'Loyalty tick interval failed',
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
