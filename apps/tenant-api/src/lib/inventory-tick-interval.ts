import { listTenantOrgIds } from '@repo/tenant-db'
import {
	fanOutInventoryTick,
	runInventoryTickLogged,
} from '../services/inventory-tick-service.ts'
import { syncEnvFromProcess } from './secrets.ts'

/**
 * Sub-hourly inventory tick on the Node (OCI) runtime: an in-process interval
 * over every organization on this node, to retry alerts the App could not
 * take. The hourly cron still reaches the node and does the digests, and a
 * doubled run is harmless (every alert has a unique key).
 * `INVENTORY_TICK_INTERVAL_SECONDS` sets the period (default 300, minimum 60,
 * `0` off). The Durable Object runtime uses alarms instead.
 */
export const DEFAULT_INVENTORY_TICK_INTERVAL_SECONDS = 300
export const MIN_INVENTORY_TICK_INTERVAL_SECONDS = 60

export function inventoryTickIntervalMs(raw: unknown): number | null {
	if (raw === undefined || raw === null || String(raw).trim() === '') {
		return DEFAULT_INVENTORY_TICK_INTERVAL_SECONDS * 1000
	}
	const seconds = Number(raw)
	if (!Number.isFinite(seconds) || seconds <= 0) return null
	return Math.max(seconds, MIN_INVENTORY_TICK_INTERVAL_SECONDS) * 1000
}

export function startInventoryTickInterval(
	options: {
		intervalMs?: number | null
		run?: () => Promise<unknown>
		setIntervalFn?: typeof setInterval
	} = {},
): { stop: () => void } | null {
	syncEnvFromProcess()
	const intervalMs =
		options.intervalMs === undefined
			? inventoryTickIntervalMs(
					typeof process !== 'undefined'
						? process.env.INVENTORY_TICK_INTERVAL_SECONDS
						: undefined,
				)
			: options.intervalMs
	if (intervalMs === null) return null
	let running = false
	const run =
		options.run ??
		(async () =>
			fanOutInventoryTick({
				orgIds: await listTenantOrgIds(),
				run: (orgId) => runInventoryTickLogged(orgId),
			}))
	const timer = (options.setIntervalFn ?? setInterval)(() => {
		// A slow pass is never overlapped by the next one.
		if (running) return
		running = true
		run()
			.catch((error) => {
				console.error(
					'Inventory tick interval failed',
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
