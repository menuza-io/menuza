import { msg } from '@lingui/core/macro'
import { type MessageDescriptor } from '@lingui/core'
import { type GiftCardLedgerKind, type GiftCardStatus } from '@repo/common/gift-cards'
import { minorToMajor } from '#app/utils/money-input.ts'

export const GIFT_CARD_STATUS_LABELS: Record<GiftCardStatus, MessageDescriptor> = {
	pending: msg`Unpaid`,
	inactive: msg`Not activated`,
	active: msg`Active`,
	held: msg`On hold`,
	frozen: msg`Frozen`,
	voided: msg`Voided`,
	expired: msg`Expired`,
}

export const GIFT_CARD_KIND_LABELS: Record<GiftCardLedgerKind, MessageDescriptor> = {
	issue: msg`Card sold`,
	top_up: msg`Topped up`,
	redeem: msg`Spent`,
	refund: msg`Returned to the card`,
	adjust: msg`Adjusted`,
	void: msg`Balance removed`,
	import: msg`Imported balance`,
	dispute_removal: msg`Removed after a lost dispute`,
	event: msg`Note`,
}

export const GIFT_CARD_CHANNEL_LABELS: Record<string, MessageDescriptor> = {
	online: msg`Online`,
	pos: msg`Till`,
	app: msg`App`,
	import: msg`Import`,
	system: msg`Menuza`,
}

export function formatGiftCardMoney(
	minor: number,
	currency: string,
	locale: string,
): string {
	try {
		return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
			minorToMajor(minor, currency),
		)
	} catch {
		return `${minorToMajor(minor, currency)} ${currency}`
	}
}

export function formatGiftCardDate(ms: number | null, locale: string): string {
	if (!ms) return '—'
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(ms)
}

/** Error codes the region answers with, as words an operator can act on. */
export const GIFT_CARD_ERROR_MESSAGES: Record<string, MessageDescriptor> = {
	stale_balance: msg`The balance changed while you were looking. Check the new balance and try again.`,
	gift_card_balance_low: msg`The card does not have enough balance.`,
	gift_card_voided: msg`This card was voided.`,
	gift_card_frozen: msg`This card is frozen.`,
	gift_card_held: msg`This card is on hold.`,
	gift_card_expired: msg`This card has expired.`,
	gift_card_inactive: msg`This card has not been activated.`,
	gift_card_refund_exceeds_charge: msg`That is more than the charge took.`,
	refund_exceeds_unspent: msg`That is more than is left on the card.`,
	code_invalid: msg`No card matches that number.`,
	rate_limited: msg`Too many tries. Wait a moment and try again.`,
	forbidden: msg`You do not have permission to do that.`,
	gift_cards_unavailable: msg`Gift cards are temporarily unavailable. Try again shortly.`,
	idempotency_conflict: msg`This was already submitted with different details.`,
	not_held: msg`This card is not waiting for review.`,
}
