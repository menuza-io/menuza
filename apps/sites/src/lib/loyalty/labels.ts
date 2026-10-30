import { type I18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { translate } from '~/lib/translate'

/** Keeps `{name}` placeholders for the browser to fill with `fillTemplate`. */
function keep(i18n: I18n, descriptor: MessageDescriptor, ...names: string[]) {
	return translate(
		i18n,
		descriptor,
		Object.fromEntries(names.map((name) => [name, `{${name}}`])),
	)
}

/** A count's wording in each plural category of the page language. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>

/** At least one count in every plural category our languages have. */
const PLURAL_SAMPLES = [0, 1, 2, 3, 11, 100, 1_000_000]

/**
 * Renders a `{n, plural, ...}` message once per plural category of the page
 * language, keeping `{count}` for the browser, which picks the form with
 * `Intl.PluralRules`. Arabic has six forms where English has two.
 */
function pluralForms(i18n: I18n, descriptor: MessageDescriptor): PluralForms {
	let rules: Intl.PluralRules | undefined
	try {
		rules = new Intl.PluralRules(i18n.locale)
	} catch {
		rules = undefined
	}
	const forms: PluralForms = {}
	for (const n of PLURAL_SAMPLES) {
		const category = rules?.select(n) ?? 'other'
		forms[category] ??= translate(i18n, descriptor, { n, count: '{count}' })
	}
	return forms
}

/**
 * Every string the rewards wallet script shows. Rendered by
 * `components/loyalty/LoyaltyLabels.astro`, read with `readLoyaltyLabels`.
 */
export function buildLoyaltyLabels(i18n: I18n) {
	const t = (descriptor: MessageDescriptor) => i18n._(descriptor)
	return {
		// Units: one integer currency, labelled points or stars. `n` picks the
		// plural form; `{count}` is the number.
		points: pluralForms(
			i18n,
			msg`{n, plural, one {{count} point} other {{count} points}}`,
		),
		stars: pluralForms(
			i18n,
			msg`{n, plural, one {{count} star} other {{count} stars}}`,
		),

		// Page states
		loading: t(msg`Loading your rewards…`),
		unavailableTitle: t(msg`Rewards are not available right now`),
		unavailableBody: t(
			msg`This business is not running a rewards program at the moment.`,
		),
		pausedNotice: t(
			msg`The rewards program is paused. Your balance is safe, but you cannot earn or redeem right now.`,
		),
		signedOutTitle: t(msg`Sign in to see your rewards`),
		signedOutBody: t(
			msg`Sign in with your phone number to see your points and use your rewards.`,
		),
		signIn: t(msg`Sign in`),
		suspendedNotice: t(
			msg`Your rewards account is on hold. Please contact the business for help.`,
		),
		retry: t(msg`Try again`),

		// Program terms (read-only)
		termsHeading: t(msg`Program terms`),

		// Balance
		balanceHeading: t(msg`Your balance`),
		reservedLabel: keep(
			i18n,
			msg`{amount} held for an order in progress`,
			'amount',
		),
		owedNotice: t(
			msg`Your balance is below zero because of a refund. New purchases will bring it back up.`,
		),
		nextRewardProgress: keep(
			i18n,
			msg`{amount} more to unlock {reward}`,
			'amount',
			'reward',
		),
		progressLabel: keep(i18n, msg`Progress to {reward}`, 'reward'),
		allRewardsUnlocked: t(msg`You have enough for every reward.`),

		// Earning
		earnHeading: t(msg`How you earn`),
		earnSpend: keep(
			i18n,
			msg`{points} for every {amount} you spend`,
			'points',
			'amount',
		),
		earnVisit: keep(i18n, msg`{points} for each visit (once a day)`, 'points'),
		earnItems: keep(i18n, msg`{points} for each {items}`, 'points', 'items'),
		earnItemsGeneric: keep(
			i18n,
			msg`{points} for each eligible item`,
			'points',
		),
		earnCategories: keep(
			i18n,
			msg`{points} for each item from {categories}`,
			'points',
			'categories',
		),
		earnCategoriesGeneric: keep(
			i18n,
			msg`{points} for each item from eligible categories`,
			'points',
		),
		earnMinimum: keep(
			i18n,
			msg`Purchases of at least {amount} qualify.`,
			'amount',
		),
		earnExcludes: t(
			msg`Tax, tips and delivery fees do not count toward earning.`,
		),

		// Rewards
		rewardsHeading: t(msg`Rewards`),
		rewardsEmpty: t(msg`No rewards are available yet.`),
		rewardCost: t(msg`Cost`),
		rewardFixedOff: keep(i18n, msg`{amount} off`, 'amount'),
		rewardPercentOff: keep(i18n, msg`{percent} off`, 'percent'),
		rewardCap: keep(i18n, msg`Up to {amount} off`, 'amount'),
		rewardScopeOrder: t(msg`Applies to your whole order`),
		rewardScopeItems: keep(i18n, msg`Applies to {items}`, 'items'),
		rewardScopeItemsGeneric: t(msg`Applies to selected items`),
		rewardScopeCategories: keep(
			i18n,
			msg`Applies to {categories}`,
			'categories',
		),
		rewardScopeCategoriesGeneric: t(msg`Applies to selected categories`),
		rewardFreeItem: keep(i18n, msg`Free {item}`, 'item'),
		rewardFreeItemGeneric: t(msg`A free item`),
		rewardFreeItemNote: t(msg`One item. Paid extras are still charged.`),
		rewardAffordable: t(msg`You have enough for this reward`),
		rewardNeedMore: keep(i18n, msg`{amount} more needed`, 'amount'),
		rewardsHowToUse: t(
			msg`Use a reward when you order, or show your code at the counter.`,
		),
		redemptionPaused: t(msg`Rewards cannot be used right now.`),
		oneRewardPerOrder: t(msg`One reward per order.`),
		oneRewardPerTab: t(msg`One reward per tab.`),

		// Order checkout and tab payment: the reward picker
		pickerBalance: keep(i18n, msg`You have {amount}`, 'amount'),
		pickerNoReward: t(msg`No reward`),
		pickerSave: keep(i18n, msg`You save {amount}`, 'amount'),
		pickerUsedOn: keep(i18n, msg`Used on {items}`, 'items'),
		pickerLeftAfter: keep(i18n, msg`{amount} left after this reward`, 'amount'),
		pickerNotApplicable: t(msg`Not available for this order`),
		pickerRemoved: t(msg`That reward no longer applies, so it was removed.`),
		pickerApplied: keep(
			i18n,
			msg`Reward applied: {amount} off. New total: {total}`,
			'amount',
			'total',
		),
		pickerRetrying: t(msg`We could not refresh your rewards. Trying again…`),
		pickerFailed: t(
			msg`That reward could not be used. Your rewards have been updated. Pick again or continue without one.`,
		),
		pickerUnconfirmed: t(
			msg`We could not confirm your reward. Try again, or continue without it.`,
		),
		pickerTabClaimed: t(
			msg`Another guest has already claimed rewards for this tab.`,
		),
		pickerCoversTotal: t(
			msg`That reward would cover the whole tab, so it cannot be used when paying from your phone. Pick another reward or pay without one.`,
		),
		pickerCoversOrder: t(
			msg`This reward covers your whole order. Choose to pay when you receive it.`,
		),
		pickerDiscount: t(msg`Reward`),

		// Counter code
		codeHeading: t(msg`Your code`),
		codeBody: t(
			msg`Show this code at the counter so staff can find your points.`,
		),
		codeNotSpending: t(
			msg`Showing your code does not spend any points. You approve every reward yourself.`,
		),
		codeShow: t(msg`Show my code`),
		codeRefresh: t(msg`Get a new code`),
		codeLoading: t(msg`Getting your code…`),
		codeLabel: t(msg`Your code`),
		codeExpiresIn: keep(i18n, msg`Expires in {time}`, 'time'),
		codeExpired: t(msg`This code has expired. Get a new one.`),
		codeReady: t(msg`Your new code is ready.`),

		// Approvals
		approvalsHeading: t(msg`Requests to use your rewards`),
		approvalsBody: t(
			msg`When staff ask to use a reward on your purchase, approve it here.`,
		),
		approvalsEmpty: t(msg`No requests right now.`),
		approvalsCheck: t(msg`Check for requests`),
		approvalTitle: keep(i18n, msg`Use {reward}?`, 'reward'),
		approvalDetail: keep(
			i18n,
			msg`Spends {points} for {amount} off`,
			'points',
			'amount',
		),
		approvalExpiresIn: keep(i18n, msg`Expires in {time}`, 'time'),
		approve: t(msg`Approve`),
		decline: t(msg`Decline`),
		approveAria: keep(i18n, msg`Approve {reward}`, 'reward'),
		declineAria: keep(i18n, msg`Decline {reward}`, 'reward'),
		approved: keep(i18n, msg`Approved: {reward}.`, 'reward'),
		declined: keep(i18n, msg`Declined: {reward}.`, 'reward'),
		approvalExpired: t(msg`That request has expired.`),
		approvalClosed: t(msg`That request was already handled.`),
		newApprovals: t(msg`You have a new request to use a reward.`),

		// History
		historyHeading: t(msg`History`),
		historyEmpty: t(msg`No activity yet. Your purchases will show up here.`),
		historyMore: t(msg`Show more`),
		historyLoadingMore: t(msg`Loading…`),
		historyEarn: t(msg`Earned`),
		historyEarnReversal: t(msg`Refund adjustment`),
		historyRedeem: keep(i18n, msg`Redeemed {reward}`, 'reward'),
		historyRedeemGeneric: t(msg`Redeemed a reward`),
		historyRedeemRestore: t(msg`Reward returned`),
		historyAdjust: t(msg`Adjusted by staff`),
		channelWeb: t(msg`Online`),
		channelPos: t(msg`In store`),
		channelQr: t(msg`Table order`),
		channelNative: t(msg`App`),

		// Errors
		errorNetwork: t(msg`Network error. Check your connection and try again.`),
		errorRateLimited: t(
			msg`Too many attempts. Please wait a moment and try again.`,
		),
		errorUnavailable: t(
			msg`Rewards are temporarily unavailable. Please try again later.`,
		),
		errorDisabled: t(msg`Rewards are not available right now.`),
		errorMemberInactive: t(msg`Your rewards account is on hold.`),
		errorProgramInactive: t(msg`The program is paused right now.`),
		errorInsufficientPoints: t(msg`Your balance is too low for this reward.`),
		errorRewardUnavailable: t(msg`This reward is no longer available.`),
		errorSignedOut: t(msg`Your session ended. Please sign in again.`),
		errorWrongSite: t(
			msg`You are signed in to a different site. Please sign in again here.`,
		),
		errorGeneric: t(msg`Something went wrong. Please try again.`),
	}
}

export type LoyaltyLabels = ReturnType<typeof buildLoyaltyLabels>
