import { ENV } from 'varlock/env'
import { listTenantOrgIds } from '@repo/tenant-db'
import { fanOutStaffTick } from '../services/staff-tick-fanout.ts'
import { runStaffTickForOrg } from '../services/staff-tick-service.ts'
import { syncEnvFromProcess } from './secrets.ts'

/**
 * Sub-hourly timing on the Node (OCI) runtime: an in-process interval that runs
 * the same tick for every organization on this node. The hourly cron remains
 * the safety net (it also reaches this node), and a missed or doubled run is
 * harmless because every task is idempotent.
 *
 * `STAFFING_TICK_INTERVAL_SECONDS` sets the period (default 300). `0` turns the
 * interval off and leaves the hourly cron as the only driver. The Durable
 * Object runtime does not use this; it has per-organization alarms.
 */
export const DEFAULT_TICK_INTERVAL_SECONDS = 300
/** Below this a mistyped value would hammer the control plane. */
export const MIN_TICK_INTERVAL_SECONDS = 60

export function tickIntervalMs(raw: unknown): number | null {
	if (raw === undefined || raw === null || String(raw).trim() === '') {
		return DEFAULT_TICK_INTERVAL_SECONDS * 1000
	}
	const seconds = Number(raw)
	if (!Number.isFinite(seconds) || seconds <= 0) return null
	return Math.max(seconds, MIN_TICK_INTERVAL_SECONDS) * 1000
}

export type TickIntervalHandle = { stop: () => void }

export function startStaffTickInterval(
	options: {
		intervalMs?: number | null
		run?: () => Promise<unknown>
		setIntervalFn?: typeof setInterval
	} = {},
): TickIntervalHandle | null {
	syncEnvFromProcess()
	const intervalMs =
		options.intervalMs === undefined
			? tickIntervalMs(
					(ENV as { STAFFING_TICK_INTERVAL_SECONDS?: unknown })
						.STAFFING_TICK_INTERVAL_SECONDS,
				)
			: options.intervalMs
	if (intervalMs === null) return null

	let running = false
	const run =
		options.run ??
		(async () =>
			fanOutStaffTick({
				orgIds: await listTenantOrgIds(),
				run: (orgId) => runStaffTickForOrg(orgId).catch(() => null),
			}))
	const timer = (options.setIntervalFn ?? setInterval)(() => {
		// A slow pass is never overlapped by the next one.
		if (running) return
		running = true
		run()
			.catch((error) => {
				console.error(
					'Staff tick interval failed',
					error instanceof Error ? error.name : 'unknown',
				)
			})
			.finally(() => {
				running = false
			})
	}, intervalMs)
	// Never keep the process alive just for the tick.
	;(timer as { unref?: () => void }).unref?.()
	return { stop: () => clearInterval(timer) }
}
