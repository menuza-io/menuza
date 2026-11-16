import { type I18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

/**
 * Every string the gift card pages show to guests. Rendered by
 * `components/gift-cards/GiftCardLabels.astro`, read in the browser with
 * `readGiftCardLabels`. `{name}` placeholders are filled by the page script.
 */
export function buildGiftCardLabels(i18n: I18n) {
	const t = (descriptor: MessageDescriptor) => i18n._(descriptor)
	return {
		// Purchase page
		buyTitle: t(msg`Buy a gift card`),
		buyIntro: t(msg`Send a gift card by email, or keep it for yourself. It works at every location.`),
		amount: t(msg`Amount`),
		customAmount: t(msg`Other amount`),
		design: t(msg`Design`),
		designClassic: t(msg`Classic`),
		designBirthday: t(msg`Happy birthday`),
		designHolidays: t(msg`Happy holidays`),
		designThankYou: t(msg`Thank you`),
		designEid: t(msg`Eid`),
		designRamadan: t(msg`Ramadan`),
		designNationalDay: t(msg`National Day`),
		designCustom: t(msg`Our own design`),
		recipientName: t(msg`To (name)`),
		recipientEmail: t(msg`To (email)`),
		sendToMyself: t(msg`Send to myself`),
		fromName: t(msg`From`),
		yourName: t(msg`Your name`),
		yourEmail: t(msg`Your email (for the receipt)`),
		message: t(msg`Add a note`),
		deliverNow: t(msg`Deliver now`),
		deliverLater: t(msg`Deliver later`),
		deliverDate: t(msg`Date`),
		deliverTime: t(msg`Time`),
		location: t(msg`Location`),
		anyLocation: t(msg`Any location`),
		total: t(msg`Total`),
		payAndSend: t(msg`Pay and send`),
		processing: t(msg`One moment…`),
		returning: t(msg`Back from checkout. Your payment is being confirmed and the card is on its way.`),
		cancelled: t(msg`Checkout was cancelled. No card was sent.`),
		checkBalance: t(msg`Check a card's balance`),
		unavailable: t(msg`Gift cards are not available right now.`),
		// Errors
		errorAmount: t(msg`Choose an amount between {min} and {max}.`),
		errorEmail: t(msg`Enter a valid email address.`),
		errorRecipient: t(msg`Enter who the card is for, or choose Send to myself.`),
		errorDeliver: t(msg`Choose a delivery time within the next year.`),
		errorVerify: t(msg`Verification failed. Please try again.`),
		errorLimit: t(msg`We cannot complete this purchase. Please try a smaller amount or contact the restaurant.`),
		errorRate: t(msg`Too many tries. Please wait a moment and try again.`),
		errorGeneric: t(msg`Something went wrong. Please try again.`),
		// Balance page
		balanceTitle: t(msg`Check your gift card balance`),
		balanceIntro: t(msg`Enter the number on your card. Dashes and spaces do not matter.`),
		cardNumber: t(msg`Card number`),
		check: t(msg`Check balance`),
		balanceIs: t(msg`Balance: {amount}`),
		endingIn: t(msg`Card ending {last4}`),
		statusInactive: t(msg`This card has not been activated.`),
		statusVoided: t(msg`This card is no longer valid. The balance is 0.`),
		statusExpired: t(msg`This card has expired. The balance is 0.`),
		statusPreparing: t(msg`Being prepared. Your card will be delivered within 2 hours.`),
		validUntil: t(msg`Valid until {date}`),
		errorNotFound: t(msg`We could not find a card with that number.`),
		// Wallet
		walletTitle: t(msg`Gift cards`),
		walletIntro: t(msg`Cards saved to your account. Anyone with a card's full number can still spend it.`),
		walletEmpty: t(msg`No cards saved yet.`),
		addCard: t(msg`Add a card`),
		add: t(msg`Add card`),
		added: t(msg`Card added to your account.`),
		recentActivity: t(msg`Recent activity`),
		showAtTill: t(msg`Show at the till`),
		showHint: t(msg`This code works once and stops working in a few minutes. It is not your card number.`),
		signInToSave: t(msg`Sign in to save gift cards to your account.`),
		signIn: t(msg`Sign in`),
		activityBought: t(msg`Card bought`),
		activitySpent: t(msg`Spent`),
		activityReturned: t(msg`Returned to the card`),
		activityToppedUp: t(msg`Topped up`),
		activityAdjusted: t(msg`Adjusted`),
		// Checkout
		giftCardAdd: t(msg`Add gift card`),
		giftCardCode: t(msg`Gift card number`),
		giftCardApply: t(msg`Apply`),
		giftCardRemove: t(msg`Remove`),
		giftCardApplied: t(msg`Gift card ending {last4}: {amount} applied`),
		giftCardRest: t(msg`Still to pay: {amount}`),
		giftCardSaved: t(msg`Use a saved card`),
		giftCardLowBalance: t(msg`The card does not have enough balance.`),
		giftCardInvalid: t(msg`We could not use that gift card.`),
		giftCardChanged: t(msg`The gift card amount changed. Review the new total.`),
	}
}

export type GiftCardLabels = ReturnType<typeof buildGiftCardLabels>
