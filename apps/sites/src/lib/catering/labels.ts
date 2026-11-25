import { type I18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import {
	type CateringPhrases,
	type CateringStandardQuestionId,
} from '@repo/common/catering'

/**
 * Every string the catering pages show to guests (#124, #255, #361, #325).
 * Rendered by `components/catering/CateringLabels.astro` and read in the
 * browser with `readCateringLabels`; `{name}` placeholders are filled by the
 * page scripts.
 */
export function buildCateringLabels(i18n: I18n) {
	const t = (descriptor: MessageDescriptor) => i18n._(descriptor)
	return {
		// The catering page
		title: t(msg`Catering`),
		intro: t(
			msg`Order food for an office lunch, a party or an event. Choose the date and we check the notice and our hours.`,
		),
		unavailable: t(msg`Catering orders are not available right now.`),
		menuHeading: t(msg`Choose your dishes`),
		quantity: t(msg`Quantity`),
		chooseOption: t(msg`Choose an option`),
		chooseUpTo: t(msg`Choose up to {max}`),
		required: t(msg`Required`),
		notOnline: t(msg`Ask us about this dish`),
		eventHeading: t(msg`Your event`),
		location: t(msg`Location`),
		eventDate: t(msg`Event date`),
		eventTime: t(msg`Time`),
		guests: t(msg`Number of guests`),
		notes: t(msg`Notes for the kitchen`),
		pickup: t(msg`Pickup`),
		delivery: t(msg`Delivery`),
		pickupOrDelivery: t(msg`Pickup or delivery`),
		deliveryAddress: t(msg`Delivery address`),
		deliveryCity: t(msg`City`),
		yourDetails: t(msg`Your details`),
		name: t(msg`Your name`),
		phone: t(msg`Phone`),
		email: t(msg`Email`),
		earliest: t(msg`Earliest date: {date}`),
		orderBy: t(msg`Order by {when}`),
		cutoffClosed: t(msg`Orders for {from} to {to} closed on {when}.`),
		cutoffClosedDay: t(msg`Orders for {from} closed on {when}.`),
		subtotal: t(msg`Dishes: {amount} before tax`),
		depositNote: t(
			msg`A {percent}% deposit is due now. You pay the balance later.`,
		),
		payNow: t(msg`Pay now`),
		payDeposit: t(msg`Pay the deposit`),
		requestQuote: t(msg`Request a quote`),
		working: t(msg`One moment…`),
		requestSent: t(
			msg`Thank you. We received your request and will send you a quote by email.`,
		),
		goodToKnow: t(msg`Good to know`),
		// Errors
		errChooseDishes: t(msg`Choose at least one dish.`),
		errChooseDate: t(msg`Choose the event date and time.`),
		errDetails: t(msg`Enter your name, phone number and email.`),
		errGuests: t(msg`Enter the number of guests.`),
		errSelection: t(msg`Check the choices for your dishes.`),
		errTooSoon: t(msg`That is too soon. Please choose a later date.`),
		errTooFar: t(msg`That is too far ahead. Please choose an earlier date.`),
		errClosed: t(
			msg`We are not taking orders at that time. Please choose another time.`,
		),
		errCutoff: t(
			msg`Orders for that date have closed. Please choose another date.`,
		),
		errMinimum: t(msg`The order is below our catering minimum.`),
		errMaximum: t(msg`The order is above what we take online. Please call us.`),
		errGuestsMax: t(
			msg`That is more guests than we can cater online. Please call us.`,
		),
		errFulfillment: t(
			msg`That is not available here. Choose pickup or delivery.`,
		),
		errVerify: t(msg`Verification failed. Please try again.`),
		errGeneric: t(msg`Something went wrong. Please try again.`),
		// Quote page
		quoteTitle: t(msg`Your catering quote`),
		quoteEvent: t(msg`Event`),
		quoteItems: t(msg`Items`),
		quoteTotal: t(msg`Total`),
		quoteTax: t(msg`Tax`),
		quoteDueNow: t(msg`Due now: {amount}`),
		quoteBalanceLater: t(msg`Balance later: {amount}`),
		quoteValidUntil: t(msg`This quote is valid until {date}.`),
		quoteNote: t(msg`A note from the restaurant`),
		acceptAndPay: t(msg`Accept and pay`),
		quoteExpired: t(
			msg`This quote has expired. Please contact the restaurant.`,
		),
		quoteGone: t(
			msg`This link is no longer valid. Ask the restaurant for the latest quote.`,
		),
		quoteNotReady: t(
			msg`This quote is not ready yet. The restaurant will email you when it is.`,
		),
		quoteAlreadyPaid: t(msg`This quote is already paid.`),
		paidThanks: t(
			msg`Payment received. Thank you: your catering order is confirmed.`,
		),
		paymentCancelled: t(
			msg`Checkout was cancelled. You have not been charged.`,
		),
		// Balance page
		balanceTitle: t(msg`Pay your catering balance`),
		balanceOrder: t(msg`Order {number}`),
		balanceDue: t(msg`Amount due: {amount}`),
		balanceDueBy: t(msg`Due by {date}`),
		balancePaid: t(msg`Paid in full. Thank you.`),
		balanceNone: t(msg`Nothing is due on this order.`),
		balanceVoid: t(
			msg`This balance was cancelled. Contact the restaurant if you have a question.`,
		),
		payBalance: t(msg`Pay the balance`),
	}
}

export type CateringLabels = ReturnType<typeof buildCateringLabels>

/** The seven standard questions, translated (#325). */
export function cateringQuestionLabels(
	i18n: I18n,
): Record<CateringStandardQuestionId, string> {
	const t = (descriptor: MessageDescriptor) => i18n._(descriptor)
	return {
		cutlery: t(msg`Do you provide plates, napkins and cutlery?`),
		dietary: t(msg`Which dietary needs can you meet?`),
		staff: t(msg`Do you offer set-up and serving staff?`),
		notice: t(msg`How much notice do you need?`),
		minimum: t(msg`Is there a minimum order?`),
		delivery: t(msg`Do you deliver, and what does it cost?`),
		deposit: t(
			msg`Is a deposit required, and what is the cancellation policy?`,
		),
	}
}

/**
 * The setting-backed answers in the site's language. Built from the settings
 * on every render, so a changed minimum notice changes the answer at once.
 */
export function cateringPhrases(i18n: I18n): CateringPhrases {
	const t = (descriptor: MessageDescriptor) => i18n._(descriptor)
	return {
		notice: (hours) => t(msg`We need at least ${hours} hours of notice.`),
		minimum: ({ minText, maxText, maxGuests }) => {
			const parts: string[] = []
			if (minText) parts.push(t(msg`The minimum catering order is ${minText}.`))
			if (maxText)
				parts.push(t(msg`The largest order we take online is ${maxText}.`))
			if (maxGuests) parts.push(t(msg`We cater for up to ${maxGuests} guests.`))
			return parts.length > 0 ? parts.join(' ') : null
		},
		delivery: ({ delivers, pickup, zones, feeText }) => {
			if (!delivers) return pickup ? t(msg`Catering is for pickup only.`) : ''
			const where = zones.join(', ')
			const parts = [
				where
					? t(msg`We deliver catering orders to ${where}.`)
					: t(msg`We deliver catering orders.`),
			]
			if (feeText) parts.push(t(msg`Delivery from ${feeText}.`))
			if (pickup) parts.push(t(msg`Pickup is available too.`))
			return parts.join(' ')
		},
		deposit: ({ percent, balanceDueDays }) =>
			percent > 0 && percent < 100
				? t(
						msg`We take a ${percent}% deposit when you order. The balance is due ${balanceDueDays} days before the event.`,
					)
				: null,
	}
}
