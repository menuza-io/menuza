/**
 * Generated legal pages for restaurant sites (#89) and the accessibility
 * statement (#260): one generator, versioned templates in every site
 * language, filled with the restaurant's details and the features it has on.
 * The templates are a starting point, not legal advice.
 */

export const LEGAL_KINDS = [
	'privacy',
	'terms',
	'cookies',
	'accessibility',
] as const
export type LegalKind = (typeof LEGAL_KINDS)[number]

/** Bump when the wording changes; pages made from older ones can be updated. */
export const LEGAL_TEMPLATE_VERSION = 1

export type LegalRegion = 'eu' | 'uk' | 'ksa' | 'us' | 'other'

/** Third parties named in the policies (brand names are never translated). */
export type TrackingTag =
	'google_analytics' | 'google_tag_manager' | 'meta_pixel' | 'tiktok_pixel'

export type PaymentProvider = 'stripe' | 'checkout'

export type LegalFeatures = {
	ordering: boolean
	delivery: boolean
	reservations: boolean
	reservationDeposits: boolean
	loyalty: boolean
	giftCards: boolean
	careers: boolean
	/** Guests sign in with a one-time code sent by text. */
	accounts: boolean
	marketing: boolean
}

export type LegalContext = {
	/** The restaurant's trading name (the organization name). */
	name: string
	/** The company that runs the website; falls back to `name`. */
	legalName: string
	email: string
	phone: string
	address: string
	region: LegalRegion
	/** `YYYY-MM-DD`, the day the text was generated. */
	date: string
	features: LegalFeatures
	trackingTags: TrackingTag[]
	paymentProviders: PaymentProvider[]
	/** The operator's own refund wording; empty says "contact the restaurant". */
	refundText: string
	/** Optional operator text for deposits and cancellation of bookings. */
	reservationText: string
	/** The site has an embed section (third-party widgets). */
	hasEmbeds: boolean
	/** The menu is offered as a PDF. */
	hasPdfMenu: boolean
}

export type LegalSection = { heading: string; paragraphs: string[] }

export type LegalDocument = {
	kind: LegalKind
	locale: string
	title: string
	sections: LegalSection[]
}

export type LegalBuildResult =
	| { ok: true; document: LegalDocument }
	| { ok: false; missing: Array<'email' | 'phone'> }

export const EMPTY_LEGAL_FEATURES: LegalFeatures = {
	ordering: true,
	delivery: false,
	reservations: false,
	reservationDeposits: false,
	loyalty: false,
	giftCards: false,
	careers: false,
	accounts: true,
	marketing: false,
}
