import { getFeatureFlag } from '@repo/common/feature-flags'

/**
 * Feature flags of the marketing automations cluster (#98 #99 #100 #150 #151
 * #155). Each is off until an organization turns it on, and only a literal
 * `true` counts. Cart reminders need order automations too.
 */
export const MARKETING_FLAG_KEYS = {
	audiences: 'marketing.audiences',
	orderAutomations: 'marketing.order_automations',
	birthdays: 'marketing.birthdays',
	cartReminders: 'marketing.cart_reminders',
	aiDrafts: 'ai.marketing_drafts',
	/** Push broadcasts and steps (#105); also needs `customer_app.push`. */
	push: 'marketing.push',
	/** Short links for texts and printed QR codes, and the Links screen (#159). */
	shortLinks: 'marketing.short_links',
	/** The seasonal marketing calendar and its suggested occasions (#152). */
	calendar: 'marketing.calendar',
} as const

export type MarketingFeatures = {
	audiences: boolean
	orderAutomations: boolean
	birthdays: boolean
	/** Needs `orderAutomations`. */
	cartReminders: boolean
	aiDrafts: boolean
	/** Push broadcasts and automation steps (needs the app's push too). */
	push: boolean
	/** Short links and the Links screen (#159). */
	shortLinks: boolean
	/** The seasonal marketing calendar (#152). */
	calendar: boolean
}

export const NO_MARKETING_FEATURES: MarketingFeatures = {
	audiences: false,
	orderAutomations: false,
	birthdays: false,
	cartReminders: false,
	aiDrafts: false,
	push: false,
	shortLinks: false,
	calendar: false,
}

const isOn = (value: unknown) => value === true || value === 'true'

export async function getMarketingFeatures(
	organizationId: string,
): Promise<MarketingFeatures> {
	const [
		[
			audiences,
			orderAutomations,
			birthdays,
			cartReminders,
			aiDrafts,
			push,
			shortLinks,
			calendar,
		],
		appPush,
	] = await Promise.all([
		Promise.all(
			Object.values(MARKETING_FLAG_KEYS).map((key) =>
				getFeatureFlag(key, { organizationId }),
			),
		),
		getFeatureFlag('customer_app.push', { organizationId }),
	])
	const orders = isOn(orderAutomations)
	return {
		audiences: isOn(audiences),
		orderAutomations: orders,
		birthdays: isOn(birthdays),
		cartReminders: orders && isOn(cartReminders),
		aiDrafts: isOn(aiDrafts),
		push: isOn(push) && isOn(appPush),
		shortLinks: isOn(shortLinks),
		calendar: isOn(calendar),
	}
}
