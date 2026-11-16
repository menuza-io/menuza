import { type I18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { type GiftCardLedgerKind } from '@repo/common/gift-cards'
import { withValues } from '../loyalty/labels'
import { type GiftCardsClientErrorCode } from './gift-cards-client'

/**
 * Every message the gift card wallet shows, as descriptors rendered later with
 * `i18n._(withValues(descriptor, values))`. Where the English source text is the
 * same as the organization website's (`apps/sites/src/lib/gift-cards/labels.ts`)
 * the message ids match.
 */
export const GIFT_CARD_LABELS = {
	// Screen states
	loading: msg`Loading your gift cards…`,
	unavailableTitle: msg`Gift cards are not available right now`,
	unavailableBody: msg`This business is not selling gift cards at the moment.`,
	signedOutTitle: msg`Sign in to see your gift cards`,
	signedOutBody: msg`Sign in with your phone number to keep your gift cards here.`,
	retry: msg`Try again`,
	emptyTitle: msg`No gift cards saved yet`,
	emptyBody: msg`Add a card with its code to keep it here. You can still spend a card with only its code.`,

	// A card
	cardEndingIn: msg`Gift card ending in {last4}`,
	balanceLabel: msg`Balance`,
	expiresOn: msg`Expires {date}`,
	beingPrepared: msg`Your card will be delivered soon. It is being prepared.`,
	recentHeading: msg`Recent activity`,

	// Status
	statusHeld: msg`On hold`,
	statusFrozen: msg`Frozen`,
	statusVoided: msg`Cancelled`,
	statusExpired: msg`Expired`,
	statusInactive: msg`Not activated`,
	statusPending: msg`Waiting for payment`,
	statusNotUsable: msg`This card cannot be used right now. Contact the business for help.`,

	// Activity
	activityIssue: msg`Card bought`,
	activityTopUp: msg`Money added`,
	activityRedeem: msg`Spent`,
	activityRefund: msg`Returned to the card`,
	activityAdjust: msg`Changed by the business`,
	activityVoid: msg`Card cancelled`,
	activityImport: msg`Balance brought over`,
	activityRemoved: msg`Balance removed`,

	// Adding a card
	addHeading: msg`Add a gift card`,
	addBody: msg`Type or paste the code from your email or card.`,
	addCodeLabel: msg`Gift card code`,
	addCodeHint: msg`Spaces and dashes do not matter.`,
	addAction: msg`Add card`,
	addSaved: msg`Saved the card ending in {last4}.`,
	addAlreadyMine: msg`The card ending in {last4} is already saved to your account.`,
	addMoveNote: msg`A card belongs to one account at a time. Adding it here moves it from any other account.`,
	dismiss: msg`Dismiss`,

	// At the till
	tillHeading: msg`Use at the till`,
	tillBody: msg`Show this code to staff to pay with the card. It works once and stops working soon.`,
	tillShow: msg`Show at the till`,
	tillRefresh: msg`Get a new code`,
	tillLoading: msg`Getting a code…`,
	tillExpiresIn: msg`Stops working in {time}`,
	tillExpired: msg`That code has expired. Get a new one.`,
	tillHide: msg`Hide`,
	tillQrLabel: msg`QR code to scan at the till for the card ending in {last4}`,
	tillNotTheCode: msg`This is not your card code. It cannot be used after it expires.`,

	// Errors
	errorGeneric: msg`Something went wrong. Please try again.`,
	errorNetwork: msg`Network error. Check your connection and try again.`,
	errorRateLimited: msg`Too many attempts. Please wait a moment and try again.`,
	errorSignedOut: msg`Your session ended. Please sign in again.`,
	errorUnavailable: msg`Gift cards are not available right now. Please try again later.`,
	errorCodeInvalid: msg`That code did not work. Check it and try again.`,
	errorNotUsable: msg`This card cannot be added right now.`,
	errorOffline: msg`Gift cards are not available on this site.`,
} as const satisfies Record<string, MessageDescriptor>

export type GiftCardLabelKey = keyof typeof GIFT_CARD_LABELS

export function renderGiftCardLabel(
	i18n: I18n,
	key: GiftCardLabelKey,
	values?: Record<string, unknown>,
): string {
	return i18n._(withValues(GIFT_CARD_LABELS[key], values))
}

const ERROR_KEYS: Partial<Record<GiftCardsClientErrorCode, GiftCardLabelKey>> =
	{
		// What a guess at a code can answer: one wording, never which part failed.
		code_invalid: 'errorCodeInvalid',
		not_found: 'errorCodeInvalid',
		invalid_request: 'errorCodeInvalid',
		rate_limited: 'errorRateLimited',
		signed_out: 'errorSignedOut',
		organization_mismatch: 'errorSignedOut',
		unauthorized: 'errorSignedOut',
		network: 'errorNetwork',
		gift_cards_unavailable: 'errorUnavailable',
		gift_cards_disabled: 'errorOffline',
		feature_disabled: 'errorOffline',
		organization_not_found: 'errorOffline',
		gift_card_held: 'errorNotUsable',
		gift_card_frozen: 'errorNotUsable',
		gift_card_voided: 'errorNotUsable',
		gift_card_expired: 'errorNotUsable',
		gift_card_inactive: 'errorNotUsable',
		gift_card_not_active: 'errorNotUsable',
		already_claimed: 'errorNotUsable',
	}

export function giftCardErrorText(
	i18n: I18n,
	code: GiftCardsClientErrorCode,
): string {
	return renderGiftCardLabel(i18n, ERROR_KEYS[code] ?? 'errorGeneric')
}

const STATUS_KEYS: Record<string, GiftCardLabelKey> = {
	held: 'statusHeld',
	frozen: 'statusFrozen',
	voided: 'statusVoided',
	expired: 'statusExpired',
	inactive: 'statusInactive',
	pending: 'statusPending',
}

/** A status worth telling the guest about; `null` for an active card. */
export function giftCardStatusText(i18n: I18n, status: string): string | null {
	const key = STATUS_KEYS[status]
	return key ? renderGiftCardLabel(i18n, key) : null
}

/** True when the card can be spent now (so the till code may be offered). */
export function giftCardUsable(status: string): boolean {
	return status === 'active'
}

const ACTIVITY_KEYS: Record<GiftCardLedgerKind, GiftCardLabelKey | null> = {
	issue: 'activityIssue',
	top_up: 'activityTopUp',
	redeem: 'activityRedeem',
	refund: 'activityRefund',
	adjust: 'activityAdjust',
	void: 'activityVoid',
	import: 'activityImport',
	dispute_removal: 'activityRemoved',
	// A history line with no money: not worth a row in a wallet.
	event: null,
}

/** The wording of a money line of the history; `null` for a line to leave out. */
export function giftCardActivityText(i18n: I18n, kind: string): string | null {
	const key = (ACTIVITY_KEYS as Record<string, GiftCardLabelKey | null>)[kind]
	return key ? renderGiftCardLabel(i18n, key) : null
}
