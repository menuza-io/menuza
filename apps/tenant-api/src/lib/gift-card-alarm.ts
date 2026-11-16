import { type OrgTickModule } from './org-alarm.ts'

/** Sub-hourly timing for gift cards on the Durable Object runtime. */
export const GIFT_CARD_ALARM_INTERVAL_MS = 5 * 60 * 1000

/**
 * Requests that show an organization is selling or using gift cards:
 * guests buying and checking cards, tills and operators.
 */
export function isGiftCardActivityPath(pathname: string): boolean {
	return (
		pathname === '/gift-cards' ||
		pathname.startsWith('/gift-cards/') ||
		pathname.startsWith('/pos/gift-cards/') ||
		pathname === '/operator/gift-cards' ||
		pathname.startsWith('/operator/gift-cards/') ||
		pathname === '/api/gift-cards/tick'
	)
}

export function createGiftCardTickModule(
	run: (
		orgId: string,
		now: number,
	) => Promise<{ needsFollowUp: boolean; nextDueAt: number | null }>,
): OrgTickModule {
	return {
		name: 'gift_cards',
		tickPath: '/api/gift-cards/tick',
		intervalMs: GIFT_CARD_ALARM_INTERVAL_MS,
		isActivityPath: isGiftCardActivityPath,
		run: async (orgId, now) => {
			const result = await run(orgId, now)
			return { needsFollowUp: result.needsFollowUp, nextDueAt: result.nextDueAt }
		},
	}
}
