import { listTenantOrgIds } from '@repo/tenant-db'
import {
	fanOutGiftCardTick,
	runGiftCardTickLogged,
} from '../services/gift-card-tick-service.ts'
import { syncEnvFromProcess } from './secrets.ts'

/**
 * Sub-hourly gift-card tick on the Node (OCI) runtime: an in-process interval
 * over every organization on this node (timed holds release and cards go out
 * on time). The hourly cron still reaches the node as a safety net, and a
 * doubled run is harmless. `GIFT_CARDS_TICK_INTERVAL_SECONDS` sets the period
 * (default 120, minimum 60, `0` off). The Durable Object runtime uses alarms.
 */
export const DEFAULT_GIFT_CARD_TICK_INTERVAL_SECONDS = 120
export const MIN_GIFT_CARD_TICK_INTERVAL_SECONDS = 60

export function giftCardTickIntervalMs(raw: unknown): number | null {
	if (raw === undefined || raw === null || String(raw).trim() === '') {
		return DEFAULT_GIFT_CARD_TICK_INTERVAL_SECONDS * 1000
	}
	const seconds = Number(raw)
	if (!Number.isFinite(seconds) || seconds <= 0) return null
	return Math.max(seconds, MIN_GIFT_CARD_TICK_INTERVAL_SECONDS) * 1000
}

export function startGiftCardTickInterval(
	options: {
		intervalMs?: number | null
		run?: () => Promise<unknown>
		setIntervalFn?: typeof setInterval
	} = {},
): { stop: () => void } | null {
	syncEnvFromProcess()
	const intervalMs =
		options.intervalMs === undefined
			? giftCardTickIntervalMs(
					typeof process !== 'undefined'
						? process.env.GIFT_CARDS_TICK_INTERVAL_SECONDS
						: undefined,
				)
			: options.intervalMs
	if (intervalMs === null) return null
	let running = false
	const run =
		options.run ??
		(async () =>
			fanOutGiftCardTick({
				orgIds: await listTenantOrgIds(),
				run: (orgId) => runGiftCardTickLogged(orgId),
			}))
	const timer = (options.setIntervalFn ?? setInterval)(() => {
		if (running) return
		running = true
		run()
			.catch((error) => {
				console.error(
					'Gift card tick interval failed',
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
