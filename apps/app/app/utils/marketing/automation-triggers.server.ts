import { i18n } from '@lingui/core'
import { t } from '@lingui/macro'
import {
	isGuestMomentJourneyTrigger,
	isOrderJourneyTrigger,
} from '@repo/tenant-db/types/journey'
import {
	getMarketingFeatures,
	type MarketingFeatures,
} from '#app/utils/marketing/marketing-flags.server.ts'

/**
 * Which of the order, birthday and cart triggers an organization may use in the
 * automation editor (#99 #151 #150). Each is behind a flag, default off. An
 * existing journey that already uses a trigger keeps saving even when its flag
 * is later switched off, so turning a flag off never strands a journey.
 */
export type AutomationTriggerAccess = {
	orderTriggers: boolean
	birthdayTriggers: boolean
	cartTriggers: boolean
	/** Offer the "Send push" step (#105): `marketing.push` and the app's push. */
	pushSteps: boolean
}

export function triggerAccessFrom(
	features: MarketingFeatures,
): AutomationTriggerAccess {
	return {
		orderTriggers: features.orderAutomations,
		birthdayTriggers: features.birthdays,
		cartTriggers: features.cartReminders,
		pushSteps: features.push,
	}
}

export async function loadAutomationTriggerAccess(organizationId: string) {
	const features = await getMarketingFeatures(organizationId)
	return { features, ...triggerAccessFrom(features) }
}

/** The error to show when a trigger may not be used, or null. */
export function marketingTriggerError(input: {
	triggerType: string
	features: MarketingFeatures
	/** The journey's saved trigger, when editing one (it may keep it). */
	currentTriggerType?: string | null
}): string | null {
	const { triggerType, features, currentTriggerType } = input
	if (currentTriggerType === triggerType) return null
	if (isOrderJourneyTrigger(triggerType) && !features.orderAutomations) {
		return i18n._(t`Turn on order automations to use this trigger`)
	}
	if (isGuestMomentJourneyTrigger(triggerType)) {
		if (triggerType === 'birthday_coming_up' && !features.birthdays) {
			return i18n._(t`Turn on birthday automations to use this trigger`)
		}
		if (triggerType === 'cart_left_behind' && !features.cartReminders) {
			return i18n._(t`Turn on cart reminders to use this trigger`)
		}
	}
	return null
}

/** "Stop when the guest places an order" is kept in the trigger's settings; the journey stores it as `goal`. */
export function goalFromTriggerConfig(
	config: Record<string, unknown> | null | undefined,
): 'order' | null {
	return config?.goal === 'order' ? 'order' : null
}

const hasPushStep = (nodes: readonly unknown[]) =>
	nodes.some(
		(node) => (node as { type?: unknown } | null)?.type === 'action_push',
	)

/**
 * "Send push" (#105) needs `marketing.push` (and the app's push). A journey
 * that already has a push step keeps saving with the flag off, so turning the
 * flag off never strands it; the step then sends nothing (the send checks the
 * flag again).
 */
export function pushStepError(input: {
	nodes: readonly unknown[]
	features: MarketingFeatures
	/** The journey's saved nodes, when editing one. */
	storedNodes?: readonly unknown[]
}): string | null {
	if (input.features.push || !hasPushStep(input.nodes)) return null
	if (input.storedNodes && hasPushStep(input.storedNodes)) return null
	return i18n._(t`Turn on push notifications to use the Send push step`)
}
