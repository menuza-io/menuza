import { isEmailSwitchOn } from '@repo/staffing'
import {
	ordersAlertSettingsSchema,
	ordersNotifyEventSchema,
	withinOpenIntervals,
	ORDERS_ALERT_SETTINGS_PATH,
	ORDERS_NOTIFY_PATH,
	type OrdersAlertSettings,
	type OrdersNotifyEvent,
} from '@repo/common/operator-alerts'
import { ENV } from 'varlock/env'
import { fetchApp } from './app-service.ts'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Manager alerts about orders and tablets (#131, #241, #300, #190): this node
 * finds what needs attention and tells the US App, which owns the people, their
 * contact details and their preferences. The event is ids, an order number, a
 * count, a time and a total; the contract is strict, so a field that could name
 * a guest never leaves the region.
 *
 * `ORDERS_ALERTS_ENABLED=false` (also `0`, `off`, `no`, `disabled`) DROPS them
 * on this node: nothing is posted and nothing is queued, so turning it back on
 * sends no backlog. Unset means on. The organization flag `orders.manager_alerts`
 * (default off) is asked of the App (`fetchOrdersAlertSettings`).
 */
export function isOrdersAlertsEnabled(): boolean {
	syncEnvFromProcess()
	const live =
		typeof process !== 'undefined' && process.env
			? process.env.ORDERS_ALERTS_ENABLED
			: (ENV as Record<string, unknown>).ORDERS_ALERTS_ENABLED
	return isEmailSwitchOn(live)
}

export type OrdersNotifyOutcome =
	| { status: 'delivered' }
	| { status: 'retry'; code: string }
	| { status: 'rejected'; code: string }

const RETRYABLE = new Set([401, 408, 425, 429, 500, 502, 503, 504])

function appUrl(): string {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

/**
 * Posts one event to the App (`POST /resources/orders/notify`, internal token).
 * `delivered` includes an App answer that skipped the event (flag off, nobody
 * to tell), so a retry is never asked of what cannot succeed; `retry` is a 401,
 * 408, 425, 429, 5xx, no network or an App that is not configured; anything
 * else is `rejected`.
 */
export async function postOrdersNotify(
	event: OrdersNotifyEvent,
): Promise<OrdersNotifyOutcome> {
	const parsed = ordersNotifyEventSchema.safeParse(event)
	if (!parsed.success) return { status: 'rejected', code: 'invalid_event' }
	const base = appUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16)
		return { status: 'retry', code: 'not_configured' }
	try {
		const response = await fetchApp(`${base}${ORDERS_NOTIFY_PATH}`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(parsed.data),
			signal: AbortSignal.timeout(8_000),
		})
		void response.body?.cancel().catch(() => undefined)
		if (!response.ok) {
			return {
				status: RETRYABLE.has(response.status) ? 'retry' : 'rejected',
				code: `http_${response.status}`,
			}
		}
		return { status: 'delivered' }
	} catch {
		return { status: 'retry', code: 'network_error' }
	}
}

const FRESH_MS = 60_000
const FAILURE_COOLDOWN_MS = 15_000
const cache = new Map<
	string,
	{ at: number; settings: OrdersAlertSettings | null }
>()

/**
 * What the App says this organization may alert about: the flag, how long an
 * order may stay New per location, opening hours and the large-order threshold
 * (`GET /resources/orders/alert-settings`). Kept for a minute. `null` when the
 * App cannot be asked: nothing is alerted then (and nothing is lost: the tick
 * asks again).
 */
export async function fetchOrdersAlertSettings(
	orgId: string,
	now = Date.now(),
): Promise<OrdersAlertSettings | null> {
	const hit = cache.get(orgId)
	if (hit && now - hit.at < (hit.settings ? FRESH_MS : FAILURE_COOLDOWN_MS)) {
		return hit.settings
	}
	const base = appUrl()
	const token = getInternalCommandToken()
	let settings: OrdersAlertSettings | null = null
	if (base && token.length >= 16) {
		try {
			const response = await fetchApp(
				`${base}${ORDERS_ALERT_SETTINGS_PATH}?${new URLSearchParams({ orgId }).toString()}`,
				{
					headers: {
						Accept: 'application/json',
						Authorization: `Bearer ${token}`,
					},
					signal: AbortSignal.timeout(5_000),
				},
			)
			if (response.ok) {
				const parsed = ordersAlertSettingsSchema.safeParse(
					await response.json().catch(() => null),
				)
				if (parsed.success) settings = parsed.data
			} else {
				void response.body?.cancel().catch(() => undefined)
			}
		} catch {
			/* fail closed: nothing is alerted */
		}
	}
	if (cache.size > 500) cache.clear()
	cache.set(orgId, { at: now, settings })
	return settings
}

export function clearOrdersAlertSettingsCache() {
	cache.clear()
}

/** Tests: set the answer without asking the App. */
export function seedOrdersAlertSettingsForTest(
	orgId: string,
	settings: OrdersAlertSettings | null,
) {
	cache.set(orgId, { at: Date.now(), settings })
}

/** Whether `nowMs` is inside the opening hours widened by `marginMs`; `null` hours: unknown. */
export const withinOpenHours = withinOpenIntervals

/**
 * Whether this organization has manager alerts on and this node's kill switch is
 * not off: the heartbeat then counts a tablet as watched (#190).
 */
export async function orderAlertsActive(orgId: string): Promise<boolean> {
	if (!isOrdersAlertsEnabled()) return false
	return (await fetchOrdersAlertSettings(orgId))?.enabled === true
}
