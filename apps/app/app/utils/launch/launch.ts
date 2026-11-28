/**
 * The restaurant launch checklist (`launch.checklist`): nine steps per
 * location, detected on read from the current state. Organization-wide steps
 * (logo, payments, domain, publish) show the same state on every location.
 * A step that was done and is undone goes back to to do, and the location
 * loses "live". Pure: the evaluator in `launch.server.ts` gathers the facts.
 */

export const LAUNCH_CHECKLIST_FLAG = 'launch.checklist'
/** "Tell your guests" was offered on the home page (once per organization). */
export const LAUNCH_GUESTS_OFFERED_FLAG = 'launch.guests_offered'

export const LAUNCH_CONDITIONS = [
	'locationHasHours',
	'menuReady',
	'brandingDone',
	'paymentsReady',
	'fulfillmentReady',
	'terminalPaired',
	'testOrderDone',
	'customDomainActive',
	'siteLive',
] as const
export type LaunchCondition = (typeof LAUNCH_CONDITIONS)[number]

export type LaunchStepDefinition = {
	key: string
	condition: LaunchCondition
	/** Optional steps can be skipped and do not hold back "live". */
	optional: boolean
	/** Same state on every location. */
	organizationWide: boolean
	/** The screen that completes it, relative to `/<orgSlug>`; `:locationId` is filled in. */
	href: string
}

/** Seeded as `OnboardingStep` rows by migration 0047 (keys and conditions). */
export const LAUNCH_STEPS: readonly LaunchStepDefinition[] = [
	{
		key: 'launch_location_details',
		condition: 'locationHasHours',
		optional: false,
		organizationWide: false,
		href: '/settings/locations/:locationId',
	},
	{
		key: 'launch_menu',
		condition: 'menuReady',
		optional: false,
		organizationWide: false,
		href: '/menu',
	},
	{
		key: 'launch_branding',
		condition: 'brandingDone',
		optional: false,
		organizationWide: true,
		href: '/website',
	},
	{
		key: 'launch_payments',
		condition: 'paymentsReady',
		optional: false,
		organizationWide: true,
		href: '/settings/shop',
	},
	{
		key: 'launch_fulfillment',
		condition: 'fulfillmentReady',
		optional: false,
		organizationWide: false,
		href: '/settings/locations/:locationId',
	},
	{
		key: 'launch_station',
		condition: 'terminalPaired',
		optional: true,
		organizationWide: false,
		href: '/settings/terminals',
	},
	{
		// Optional until the test-order flow (#119) ships.
		key: 'launch_test_order',
		condition: 'testOrderDone',
		optional: true,
		organizationWide: true,
		href: '/website',
	},
	{
		key: 'launch_custom_domain',
		condition: 'customDomainActive',
		optional: true,
		organizationWide: true,
		// The one Domain screen: connect a domain, or get one there (#139, #183).
		href: '/website/domain',
	},
	{
		key: 'launch_go_live',
		condition: 'siteLive',
		optional: false,
		organizationWide: false,
		href: '/website',
	},
]

export function launchStepByKey(key: string) {
	return LAUNCH_STEPS.find((step) => step.key === key) ?? null
}

/** Everything the steps and the live rule read, for one location. */
export type LocationLaunchFacts = {
	hasAddress: boolean
	hasHours: boolean
	/** At least one category with 5 or more priced items. */
	hasFullCategory: boolean
	/** Menu health 60 or more: `menuHealthMeetsGrade(health, 'D')`. */
	menuHealthOk: boolean
	hasLogo: boolean
	hasTheme: boolean
	onlinePayments: boolean
	payAtPickupOnly: boolean
	/** Pickup on, or delivery on with at least one zone. */
	hasChannel: boolean
	prepTimeSet: boolean
	/** Null when the region could not say. */
	terminalPaired: boolean | null
	/** Null when the region could not say. */
	hasCountedOrder: boolean | null
	customDomainActive: boolean
	sitePublished: boolean
	/** Not paused and at least one channel on. */
	orderingOn: boolean
	locationActive: boolean
	sellableItems: number
}

export function evaluateLaunchCondition(
	condition: LaunchCondition,
	facts: LocationLaunchFacts,
): boolean {
	switch (condition) {
		case 'locationHasHours':
			return facts.hasAddress && facts.hasHours
		case 'menuReady':
			return facts.hasFullCategory && facts.menuHealthOk
		case 'brandingDone':
			return facts.hasLogo && facts.hasTheme
		case 'paymentsReady':
			return facts.onlinePayments || facts.payAtPickupOnly
		case 'fulfillmentReady':
			return facts.hasChannel && facts.prepTimeSet
		case 'terminalPaired':
			return facts.terminalPaired === true
		case 'testOrderDone':
			return facts.hasCountedOrder === true
		case 'customDomainActive':
			return facts.customDomainActive
		case 'siteLive':
			return facts.sitePublished && facts.orderingOn
	}
}

/**
 * "Live": every required step done, and the live rules: published site,
 * ordering not turned off for the location, the location active, at least
 * one sellable dish, and either payments connected or pay at pickup chosen.
 * A real paid order is not required. Undoing a required step (hours deleted,
 * payments disconnected) takes live away again.
 */
export function isLocationLive(facts: LocationLaunchFacts): boolean {
	return (
		LAUNCH_STEPS.every(
			(step) => step.optional || evaluateLaunchCondition(step.condition, facts),
		) &&
		facts.sitePublished &&
		facts.orderingOn &&
		facts.locationActive &&
		facts.sellableItems > 0 &&
		(facts.onlinePayments || facts.payAtPickupOnly)
	)
}

export type LaunchStepState = 'done' | 'todo' | 'optional' | 'skipped'

export function launchStepState(
	step: Pick<LaunchStepDefinition, 'optional'>,
	done: boolean,
	skipped: boolean,
): LaunchStepState {
	if (done) return 'done'
	if (step.optional) return skipped ? 'skipped' : 'optional'
	return 'todo'
}

export type LaunchStepView = {
	key: string
	condition: LaunchCondition
	optional: boolean
	organizationWide: boolean
	state: LaunchStepState
	href: string
	completedAt: string | null
	skippedAt: string | null
	skipReason: string | null
}

export type LaunchLocationView = {
	id: string
	name: string
	live: boolean
	liveAt: string | null
	steps: LaunchStepView[]
	requiredDone: number
	requiredTotal: number
	/**
	 * Opening hours that look like a mistake (#275): how many warnings the saved
	 * hours have, none once dismissed. A note on the hours step, never a block.
	 */
	hoursWarnings?: number
}

export type LaunchChecklist = {
	locations: LaunchLocationView[]
	/** The organization's public site, for "You're live". */
	siteUrl: string
	/** "Tell your guests" was already offered on the home page. */
	guestsOffered: boolean
	/** `launch.test_order` is on: the Place a test order step offers its button (#119). */
	testOrdersEnabled?: boolean
}

export const SKIP_REASON_MAX = 200
