import {
	DISCOUNT_NOTIFY_PATH,
	discountNotifyEventSchema,
	type DiscountNotifyEvent,
} from '@repo/discounts'
import { ENV } from 'varlock/env'
import { fetchApp } from './app-service.ts'
import { runInBackground } from './background.ts'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Posts one discount notice to the US App (`POST /resources/discounts/notify`,
 * internal token): a weekly budget (#392) ran out. An organization id, a kind,
 * a discount id and a week: the schema is strict, so nothing about a guest,
 * an order or an amount can leave. The App owns the names, the recipients and
 * their preferences. Best effort, never throws: the discount's pause is
 * decided by the counts, not by this message, so a lost notice only means the
 * owner learns from the discount's page instead.
 */
export async function postDiscountNotify(
	event: DiscountNotifyEvent,
): Promise<'delivered' | 'retry' | 'rejected'> {
	const parsed = discountNotifyEventSchema.safeParse(event)
	if (!parsed.success) return 'rejected'
	syncEnvFromProcess()
	const base = (ENV.APP_URL || '').replace(/\/$/, '')
	const token = getInternalCommandToken()
	if (!base || token.length < 16) return 'retry'
	try {
		const response = await fetchApp(`${base}${DISCOUNT_NOTIFY_PATH}`, {
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
		if (response.ok) return 'delivered'
		return [401, 408, 425, 429, 500, 502, 503, 504].includes(response.status)
			? 'retry'
			: 'rejected'
	} catch {
		return 'retry'
	}
}

/**
 * Tells the owner, once the order has committed, which weekly budgets that
 * order spent. In the background: the guest never waits for it, and the App
 * sends one notice per discount and week however often this is called.
 */
export function notifyDiscountBudgets(
	orgId: string,
	crossings: ReadonlyArray<{ discountId: string; week: string }>,
): void {
	for (const crossing of crossings) {
		runInBackground(
			postDiscountNotify({
				orgId,
				kind: 'budget_reached',
				discountId: crossing.discountId,
				week: crossing.week,
			}),
		)
	}
}
