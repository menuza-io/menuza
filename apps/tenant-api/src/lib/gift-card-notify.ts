import {
	GIFT_CARD_NOTIFY_PATH,
	giftCardNotifyEventSchema,
	type GiftCardNotifyEvent,
} from '@repo/common/gift-cards'
import { ENV } from 'varlock/env'
import { fetchApp } from './app-service.ts'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Posts one gift-card notice to the US App (`POST /resources/gift-cards/notify`,
 * internal token): a burst of purchases, cards waiting for review, a frozen
 * card, a delivery that keeps failing. Ids and a count only (the schema is
 * strict); the App owns operators' emails and preferences. Best effort, never
 * throws: the card state itself is already recorded.
 */
export async function postGiftCardNotify(
	event: GiftCardNotifyEvent,
): Promise<'delivered' | 'retry' | 'rejected'> {
	const parsed = giftCardNotifyEventSchema.safeParse(event)
	if (!parsed.success) return 'rejected'
	syncEnvFromProcess()
	const base = (ENV.APP_URL || '').replace(/\/$/, '')
	const token = getInternalCommandToken()
	if (!base || token.length < 16) return 'retry'
	try {
		const response = await fetchApp(`${base}${GIFT_CARD_NOTIFY_PATH}`, {
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
