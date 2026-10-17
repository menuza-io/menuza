import { ENV } from 'varlock/env'
import { listTenantOrgIds } from '@repo/tenant-db'
import { fanOutReservationsTick } from '../services/rsv-tick-fanout.ts'
import { runReservationsTickForOrg } from '../services/rsv-tick-service.ts'
import { syncEnvFromProcess } from './secrets.ts'

/**
 * Sub-hourly timing for reservations on the Node (OCI) runtime: an in-process
 * interval that runs the reservations tick for every organization on this node.
 * The hourly cron still reaches this node as a safety net, and a doubled run is
 * harmless because every task is idempotent.
 *
 * `RESERVATIONS_TICK_INTERVAL_SECONDS` sets the period (default 120, minimum
 * 60). `0` turns the interval off. The Durable Object runtime uses per-
 * organization alarms instead.
 */
export const DEFAULT_RESERVATIONS_TICK_INTERVAL_SECONDS = 120
export const MIN_RESERVATIONS_TICK_INTERVAL_SECONDS = 60

export function reservationsTickIntervalMs(raw: unknown): number | null {
	if (raw === undefined || raw === null || String(raw).trim() === '') {
		return DEFAULT_RESERVATIONS_TICK_INTERVAL_SECONDS * 1000
	}
	const seconds = Number(raw)
	if (!Number.isFinite(seconds) || seconds <= 0) return null
	return Math.max(seconds, MIN_RESERVATIONS_TICK_INTERVAL_SECONDS) * 1000
}

export type ReservationsTickIntervalHandle = { stop: () => void }

export function startReservationsTickInterval(
	options: {
		intervalMs?: number | null
		run?: () => Promise<unknown>
		setIntervalFn?: typeof setInterval
	} = {},
): ReservationsTickIntervalHandle | null {
	syncEnvFromProcess()
	const intervalMs =
		options.intervalMs === undefined
			? reservationsTickIntervalMs(
					(ENV as { RESERVATIONS_TICK_INTERVAL_SECONDS?: unknown })
						.RESERVATIONS_TICK_INTERVAL_SECONDS,
				)
			: options.intervalMs
	if (intervalMs === null) return null

	let running = false
	const run =
		options.run ??
		(async () =>
			fanOutReservationsTick({
				orgIds: await listTenantOrgIds(),
				run: (orgId) => runReservationsTickForOrg(orgId).catch(() => null),
			}))
	const timer = (options.setIntervalFn ?? setInterval)(() => {
		// A slow pass is never overlapped by the next one.
		if (running) return
		running = true
		run()
			.catch((error) => {
				console.error(
					'Reservations tick interval failed',
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
