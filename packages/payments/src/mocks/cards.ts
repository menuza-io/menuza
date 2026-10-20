import { digitsOnly, passesLuhn } from './util'

/** Why a charge or setup is refused. */
export type StripeDecline = {
	code: 'card_declined'
	declineCode: 'generic_decline' | 'insufficient_funds'
	message: string
}

export type StripeCardProfile = {
	key: string
	brand: 'visa'
	/** Needs a 3DS challenge when the cardholder is present. */
	threeDS: boolean
	/** Off-session charges fail with `authentication_required`. */
	offSessionAuthRequired: boolean
	/** Attaching or setting the card up fails. */
	setupDecline: StripeDecline | null
	/** Every charge fails. */
	chargeDecline: StripeDecline | null
	/** Refunds stay `pending` and then settle to this outcome. */
	asyncRefund: 'succeeded' | 'failed' | null
	/** A dispute follows a successful charge. */
	dispute: boolean
}

const generic: StripeDecline = {
	code: 'card_declined',
	declineCode: 'generic_decline',
	message: 'Your card was declined.',
}
const insufficient: StripeDecline = {
	code: 'card_declined',
	declineCode: 'insufficient_funds',
	message: 'Your card has insufficient funds.',
}

const base: Omit<StripeCardProfile, 'key'> = {
	brand: 'visa',
	threeDS: false,
	offSessionAuthRequired: false,
	setupDecline: null,
	chargeDecline: null,
	asyncRefund: null,
	dispute: false,
}

export const STRIPE_CARD_PROFILES: Record<string, StripeCardProfile> = {
	'4242424242424242': { ...base, key: '4242424242424242' },
	'4000002500003155': { ...base, key: '4000002500003155', threeDS: true },
	'4000002760003184': {
		...base,
		key: '4000002760003184',
		threeDS: true,
		offSessionAuthRequired: true,
	},
	'4000000000000341': {
		...base,
		key: '4000000000000341',
		chargeDecline: generic,
	},
	'4000000000009995': {
		...base,
		key: '4000000000009995',
		chargeDecline: insufficient,
		setupDecline: insufficient,
	},
	'4000000000000002': {
		...base,
		key: '4000000000000002',
		chargeDecline: generic,
		setupDecline: generic,
	},
	'4000008260003178': {
		...base,
		key: '4000008260003178',
		threeDS: true,
		chargeDecline: insufficient,
	},
	'4000000000007726': {
		...base,
		key: '4000000000007726',
		asyncRefund: 'succeeded',
	},
	'4000000000005126': {
		...base,
		key: '4000000000005126',
		asyncRefund: 'failed',
	},
	'4000000000000259': { ...base, key: '4000000000000259', dispute: true },
	// Server-side token twin of `...9995`: attaches, then every charge fails.
	pm_card_visa_chargeDeclinedInsufficientFunds: {
		...base,
		key: 'pm_card_visa_chargeDeclinedInsufficientFunds',
		chargeDecline: insufficient,
	},
}

/** Stripe's server-side test PaymentMethod tokens. */
export const STRIPE_PAYMENT_METHOD_TOKENS: Record<string, string> = {
	pm_card_visa: '4242424242424242',
	pm_card_authenticationRequired: '4000002760003184',
	pm_card_chargeCustomerFail: '4000000000000341',
	pm_card_visa_chargeDeclinedInsufficientFunds:
		'pm_card_visa_chargeDeclinedInsufficientFunds',
	pm_card_threeDSecure2Required: '4000002500003155',
}

export const NON_TEST_CARD_MESSAGE =
	'Your card was declined. Your request was in test mode, but used a non test card. For a list of valid test cards, visit: https://docs.stripe.com/testing.'

export type CardInput = {
	number: string
	expiry: string
	cvc: string
}

export type CardValidation =
	| { ok: true; digits: string; expMonth: number; expYear: number }
	| {
			ok: false
			code: 'invalid_number' | 'invalid_expiry' | 'invalid_cvc'
			message: string
	  }

/** Luhn, future expiry (`MM/YY` or `MM/YYYY`), 3 to 4 digit CVC. */
export function validateCardInput(
	input: CardInput,
	now: number,
): CardValidation {
	const digits = digitsOnly(input.number)
	if (!passesLuhn(digits)) {
		return {
			ok: false,
			code: 'invalid_number',
			message: 'Your card number is invalid.',
		}
	}
	const match = /^\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s*$/.exec(input.expiry)
	if (!match) {
		return {
			ok: false,
			code: 'invalid_expiry',
			message: "Your card's expiration date is incomplete.",
		}
	}
	const expMonth = Number(match[1])
	let expYear = Number(match[2])
	if (expYear < 100) expYear += 2000
	const today = new Date(now)
	const currentIndex = today.getUTCFullYear() * 12 + today.getUTCMonth()
	if (
		expMonth < 1 ||
		expMonth > 12 ||
		expYear * 12 + (expMonth - 1) < currentIndex
	) {
		return {
			ok: false,
			code: 'invalid_expiry',
			message: "Your card's expiration date is in the past.",
		}
	}
	if (!/^\d{3,4}$/.test(input.cvc.trim())) {
		return {
			ok: false,
			code: 'invalid_cvc',
			message: "Your card's security code is incomplete.",
		}
	}
	return { ok: true, digits, expMonth, expYear }
}

export function stripeProfileForDigits(
	digits: string,
): StripeCardProfile | null {
	return STRIPE_CARD_PROFILES[digits] ?? null
}

// ---------------------------------------------------------------- Checkout.com

export type CheckoutCardProfile = {
	key: string
	scheme: 'visa' | 'mastercard' | 'mada'
	threeDS: boolean
	/** Clearly labeled mock: customer-initiated approves, MIT declines 20046. */
	mitDeclines: boolean
	label: string
}

export const CHECKOUT_CARD_PROFILES: Record<string, CheckoutCardProfile> = {
	'4242424242424242': {
		key: '4242424242424242',
		scheme: 'visa',
		threeDS: false,
		mitDeclines: false,
		label: 'Visa',
	},
	'5436031030606378': {
		key: '5436031030606378',
		scheme: 'mastercard',
		threeDS: false,
		mitDeclines: false,
		label: 'Mastercard',
	},
	'4543474002249996': {
		key: '4543474002249996',
		scheme: 'visa',
		threeDS: true,
		mitDeclines: false,
		label: 'Visa (3DS)',
	},
	'5352151570003404': {
		key: '5352151570003404',
		scheme: 'mastercard',
		threeDS: true,
		mitDeclines: false,
		label: 'Mastercard (3DS)',
	},
	'5297412542005689': {
		key: '5297412542005689',
		scheme: 'mada',
		threeDS: true,
		mitDeclines: true,
		label: 'mada (co-badged, mock)',
	},
}

export const CHECKOUT_3DS_PASSWORD = 'Checkout1!'

/** Amount-based declines apply to customer- and merchant-initiated payments. */
export const CHECKOUT_AMOUNT_DECLINES: Record<
	string,
	{ responseCode: string; summary: string }
> = {
	'05': { responseCode: '20005', summary: 'Declined - Do Not Honour' },
	'51': { responseCode: '20051', summary: 'Declined - Insufficient Funds' },
	'12': { responseCode: '20012', summary: 'Declined - Invalid Transaction' },
	'54': { responseCode: '20054', summary: 'Declined - Expired Card' },
}

export const CHECKOUT_MIT_DECLINE = {
	responseCode: '20046',
	summary: 'Declined - MIT not supported (mock)',
}

export const CHECKOUT_3DS_FAILED = {
	responseCode: '20153',
	summary: 'Declined - 3DS authentication failed',
}

export function checkoutAmountDecline(amount: number) {
	return (
		CHECKOUT_AMOUNT_DECLINES[String(Math.abs(amount) % 100).padStart(2, '0')] ??
		null
	)
}

export function checkoutProfileForDigits(digits: string) {
	return CHECKOUT_CARD_PROFILES[digits] ?? null
}
