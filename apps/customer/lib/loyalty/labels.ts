import { type I18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { type LoyaltyClientErrorCode } from './loyalty-client'

/**
 * Every message the rewards wallet shows, as descriptors rendered later with
 * `i18n._(withValues(descriptor, values))`. Where the English source text is
 * the same as the organization website's (`apps/sites/src/lib/loyalty/labels.ts`),
 * the message ids match.
 *
 * Units: one integer currency, labelled points or stars. `n` picks the
 * plural form and `{count}` is the formatted number; render them with
 * `formatPoints`, which also handles forms that carry no number.
 */
export const LOYALTY_LABELS = {
	points: msg`{n, plural, one {{count} point} other {{count} points}}`,
	stars: msg`{n, plural, one {{count} star} other {{count} stars}}`,

	// Screen states
	loading: msg`Loading your rewards…`,
	unavailableTitle: msg`Rewards are not available right now`,
	unavailableBody: msg`This business is not running a rewards program at the moment.`,
	pausedNotice: msg`The rewards program is paused. Your balance is safe, but you cannot earn or redeem right now.`,
	signedOutTitle: msg`Sign in to see your rewards`,
	signedOutBody: msg`Sign in with your phone number to see your points and use your rewards.`,
	signIn: msg`Sign in`,
	suspendedNotice: msg`Your rewards account is on hold. Please contact the business for help.`,
	retry: msg`Try again`,

	// Program terms (display text only)
	termsHeading: msg`Program terms`,

	// Balance
	balanceHeading: msg`Your points`,
	reservedLabel: msg`{amount} held for an order in progress`,
	owedNotice: msg`Your balance is below zero because of a refund. New purchases will bring it back up.`,
	nextRewardProgress: msg`{amount} more to unlock {reward}`,
	progressLabel: msg`Progress to {reward}`,
	allRewardsUnlocked: msg`You have enough for every reward.`,

	// Earning
	earnHeading: msg`How you earn`,
	earnSpend: msg`{points} for every {amount} you spend`,
	earnVisit: msg`{points} for each visit (once a day)`,
	earnItems: msg`{points} for each {items}`,
	earnItemsGeneric: msg`{points} for each eligible item`,
	earnCategories: msg`{points} for each item from {categories}`,
	earnCategoriesGeneric: msg`{points} for each item from eligible categories`,
	earnMinimum: msg`Purchases of at least {amount} qualify.`,
	earnExcludes: msg`Tax, tips and delivery fees do not count toward earning.`,

	// Rewards
	rewardsHeading: msg`Rewards`,
	rewardsEmpty: msg`No rewards are available yet.`,
	rewardCost: msg`Cost`,
	rewardFixedOff: msg`{amount} off`,
	rewardPercentOff: msg`{percent} off`,
	rewardCap: msg`Up to {amount} off`,
	rewardScopeOrder: msg`Applies to your whole order`,
	rewardScopeItems: msg`Applies to {items}`,
	rewardScopeItemsGeneric: msg`Applies to selected items`,
	rewardScopeCategories: msg`Applies to {categories}`,
	rewardScopeCategoriesGeneric: msg`Applies to selected categories`,
	rewardFreeItem: msg`Free {item}`,
	rewardFreeItemGeneric: msg`A free item`,
	rewardFreeItemNote: msg`One item. Paid extras are still charged.`,
	rewardAffordable: msg`You have enough for this reward`,
	rewardNeedMore: msg`{amount} more needed`,
	rewardsHowToUse: msg`Use a reward when you order, or show your code at the counter.`,
	redemptionPaused: msg`Rewards cannot be used right now.`,
	oneRewardPerOrder: msg`One reward per order.`,

	// Member code
	codeHeading: msg`Your code`,
	codeBody: msg`Show this code at the counter so staff can find your points.`,
	codeNotSpending: msg`Showing your code does not spend any points. You approve every reward yourself.`,
	codeShow: msg`Show my code`,
	codeRefresh: msg`Get a new code`,
	codeLoading: msg`Getting your code…`,
	codeLabel: msg`Your code at the counter`,
	codeExpiresIn: msg`Expires in {time}`,
	codeExpired: msg`This code has expired. Get a new one.`,
	codeReady: msg`Your new code is ready.`,

	// Approvals
	approvalsHeading: msg`Requests to use your rewards`,
	approvalsBody: msg`When staff ask to use a reward on your purchase, approve it here.`,
	approvalsEmpty: msg`No requests right now.`,
	approvalsCheck: msg`Check for requests`,
	approvalTitle: msg`Use {reward}?`,
	approvalDetail: msg`Spends {points} for {amount} off`,
	approvalExpiresIn: msg`Expires in {time}`,
	approve: msg`Approve`,
	decline: msg`Decline`,
	approveAria: msg`Approve {reward}`,
	declineAria: msg`Decline {reward}`,
	approved: msg`Approved: {reward}.`,
	declined: msg`Declined: {reward}.`,
	approvalExpired: msg`That request has expired.`,
	approvalClosed: msg`That request was already handled.`,
	newApprovals: msg`You have a new request to use a reward.`,

	// History
	historyHeading: msg`History`,
	historyEmpty: msg`No activity yet. Your purchases will show up here.`,
	historyMore: msg`Show more`,
	historyLoadingMore: msg`Loading…`,
	historyEarn: msg`Earned`,
	historyEarnReversal: msg`Refund adjustment`,
	historyRedeem: msg`Redeemed {reward}`,
	historyRedeemGeneric: msg`Redeemed a reward`,
	historyRedeemRestore: msg`Reward returned`,
	historyAdjust: msg`Adjusted by staff`,
	channelWeb: msg`Online`,
	channelPos: msg`In store`,
	channelQr: msg`Table order`,
	channelNative: msg`App`,

	// Errors
	errorNetwork: msg`Network error. Check your connection and try again.`,
	errorRateLimited: msg`Too many attempts. Please wait a moment and try again.`,
	errorUnavailable: msg`Rewards are temporarily unavailable. Please try again later.`,
	errorDisabled: msg`Rewards are not available right now.`,
	errorMemberInactive: msg`Your rewards account is on hold.`,
	errorProgramInactive: msg`The program is paused right now.`,
	errorInsufficientPoints: msg`Your balance is too low for this reward.`,
	errorRewardUnavailable: msg`This reward is no longer available.`,
	errorSignedOut: msg`Your session ended. Please sign in again.`,
	errorWrongSite: msg`You are signed in to a different site. Please sign in again here.`,
	errorGeneric: msg`Something went wrong. Please try again.`,
} satisfies Record<string, MessageDescriptor>

export type LoyaltyLabelKey = keyof typeof LOYALTY_LABELS

type ErrorLabelKey = Extract<
	LoyaltyLabelKey,
	| 'errorNetwork'
	| 'errorRateLimited'
	| 'errorUnavailable'
	| 'errorDisabled'
	| 'errorMemberInactive'
	| 'errorProgramInactive'
	| 'errorInsufficientPoints'
	| 'errorRewardUnavailable'
	| 'redemptionPaused'
	| 'errorSignedOut'
	| 'errorWrongSite'
	| 'approvalExpired'
	| 'approvalClosed'
	| 'errorGeneric'
>

/** Every code, so a code added to `@repo/loyalty` fails to compile until it has a message. */
export const LOYALTY_ERROR_LABELS: Readonly<
	Record<LoyaltyClientErrorCode, ErrorLabelKey>
> = {
	loyalty_unavailable: 'errorUnavailable',
	loyalty_disabled: 'errorDisabled',
	redemption_disabled: 'redemptionPaused',
	program_not_found: 'errorDisabled',
	program_inactive: 'errorProgramInactive',
	member_not_found: 'errorGeneric',
	member_inactive: 'errorMemberInactive',
	reward_not_found: 'errorRewardUnavailable',
	reward_unavailable: 'errorRewardUnavailable',
	reward_not_applicable: 'errorGeneric',
	zero_value: 'errorGeneric',
	insufficient_points: 'errorInsufficientPoints',
	currency_mismatch: 'errorGeneric',
	stacking_not_allowed: 'errorGeneric',
	one_reward_per_order: 'errorGeneric',
	cart_changed: 'errorGeneric',
	stale_version: 'errorGeneric',
	idempotency_conflict: 'errorGeneric',
	redemption_not_found: 'errorGeneric',
	invalid_transition: 'errorGeneric',
	purchase_not_found: 'errorGeneric',
	already_claimed: 'errorGeneric',
	refund_exceeds_payment: 'errorGeneric',
	refund_not_online: 'errorGeneric',
	refund_not_paid: 'errorGeneric',
	code_invalid: 'errorGeneric',
	binding_invalid: 'errorGeneric',
	approval_not_found: 'approvalClosed',
	approval_expired: 'approvalExpired',
	approval_closed: 'approvalClosed',
	otp_unavailable: 'errorGeneric',
	otp_invalid: 'errorGeneric',
	otp_locked: 'errorGeneric',
	adjustment_invalid: 'errorGeneric',
	adjustment_limit: 'errorGeneric',
	config_invalid: 'errorGeneric',
	location_forbidden: 'errorGeneric',
	unauthorized_scope: 'errorGeneric',
	forbidden_grant: 'errorGeneric',
	rate_limited: 'errorRateLimited',
	invalid_request: 'errorGeneric',
	signed_out: 'errorSignedOut',
	organization_mismatch: 'errorWrongSite',
	organization_not_found: 'errorDisabled',
	network: 'errorNetwork',
	invalid_response: 'errorGeneric',
	unknown: 'errorGeneric',
}

/** Which message a failed call shows. */
export function loyaltyErrorLabelKey(
	code: LoyaltyClientErrorCode,
): ErrorLabelKey {
	return LOYALTY_ERROR_LABELS[code] ?? 'errorGeneric'
}

export function loyaltyErrorMessage(
	code: LoyaltyClientErrorCode,
): MessageDescriptor {
	return LOYALTY_LABELS[loyaltyErrorLabelKey(code)]
}

/**
 * A descriptor carrying its values. Built in a function rather than spread
 * inline at the call: the Lingui extractor fails on an `i18n._({ ...x })`
 * object, and the published types take values only with a string id.
 */
export function withValues(
	descriptor: MessageDescriptor,
	values?: Record<string, unknown>,
): MessageDescriptor {
	return values ? { ...descriptor, values } : descriptor
}

export function renderLoyaltyLabel(
	i18n: I18n,
	key: LoyaltyLabelKey,
	values?: Record<string, unknown>,
): string {
	return i18n._(withValues(LOYALTY_LABELS[key], values))
}

export function loyaltyErrorText(
	i18n: I18n,
	code: LoyaltyClientErrorCode,
): string {
	return i18n._(loyaltyErrorMessage(code))
}

/** A count's wording in each plural category of a language, with `{count}` kept. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>

/** At least one count in every plural category the content languages have. */
const PLURAL_SAMPLES = [0, 1, 2, 3, 11, 100, 1_000_000]

/**
 * Renders a `{n, plural, ...}` message once per plural category of the
 * i18n language, keeping `{count}` in place. Arabic has six forms where
 * English has two, and some of them carry no number.
 */
export function pluralForms(
	i18n: I18n,
	descriptor: MessageDescriptor,
): PluralForms {
	let rules: Intl.PluralRules | undefined
	try {
		rules = new Intl.PluralRules(i18n.locale)
	} catch {
		rules = undefined
	}
	const forms: PluralForms = {}
	for (const n of PLURAL_SAMPLES) {
		const category = rules?.select(n) ?? 'other'
		forms[category] ??= i18n._(withValues(descriptor, { n, count: '{count}' }))
	}
	return forms
}
