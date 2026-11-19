/**
 * Google Business Profile rules shared by the App, the jobs and the browser
 * (#87, #284, #209, #199). Pure: no I/O, no UI strings (problems are codes,
 * worded in the App's Lingui labels).
 */

export const GBP_FLAGS = {
	sync: 'gbp.sync',
	write: 'gbp.write',
	insights: 'gbp.insights',
	socialGoogle: 'social.google',
} as const

/** Fields Menuza may keep in sync. The operator opts in per field. */
export const GBP_SYNC_FIELDS = [
	'hours',
	'specialHours',
	'phone',
	'website',
	'links',
	'openState',
	'attributes',
] as const
export type GbpSyncField = (typeof GBP_SYNC_FIELDS)[number]

/**
 * Fields that change only on an explicit "Use Menuza's value" (Google may
 * re-verify the business after these edits, #87).
 */
export const GBP_EXPLICIT_FIELDS = ['name', 'address', 'categories'] as const
export type GbpExplicitField = (typeof GBP_EXPLICIT_FIELDS)[number]

export type GbpIssueField =
	GbpSyncField | GbpExplicitField | 'orderLink' | 'reserveLink'

/** The `updateMask` Google needs for each pushed field. */
export const GBP_UPDATE_MASK: Record<
	Exclude<GbpSyncField, 'links' | 'attributes'> | GbpExplicitField,
	string
> = {
	hours: 'regularHours',
	specialHours: 'specialHours',
	phone: 'phoneNumbers',
	website: 'websiteUri',
	openState: 'openInfo.status',
	name: 'title',
	address: 'storefrontAddress',
	categories: 'categories',
}

export function isGbpSyncField(value: string): value is GbpSyncField {
	return (GBP_SYNC_FIELDS as readonly string[]).includes(value)
}

export function parseFieldsSynced(
	raw: string | null | undefined,
): GbpSyncField[] {
	if (!raw) return [...GBP_SYNC_FIELDS]
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!Array.isArray(parsed)) return [...GBP_SYNC_FIELDS]
		return parsed.filter(
			(item): item is GbpSyncField =>
				typeof item === 'string' && isGbpSyncField(item),
		)
	} catch {
		return [...GBP_SYNC_FIELDS]
	}
}

// ---------------------------------------------------------------------------
// Connection states and error codes
// ---------------------------------------------------------------------------

export const GBP_CONNECTION_STATES = [
	'ok',
	'not_verified',
	'suspended',
	'access_lost',
	'token_expired',
] as const
export type GbpConnectionState = (typeof GBP_CONNECTION_STATES)[number]

export const GBP_ERROR_CODES = [
	'gbp_not_verified',
	'gbp_suspended',
	'gbp_access_lost',
	'gbp_location_taken',
	'gbp_token_expired',
	'gbp_rate_limited',
	'gbp_rejected',
	'gbp_api_error',
	'gbp_sync_off',
	'gbp_edit_held',
	'gbp_postcard_too_soon',
] as const
export type GbpErrorCode = (typeof GBP_ERROR_CODES)[number]

export class GbpError extends Error {
	constructor(
		readonly code: GbpErrorCode,
		readonly status?: number,
		/** Google's reason, when it gave one. */
		readonly reason?: string,
	) {
		super(code)
		this.name = 'GbpError'
	}
}

export function connectionStateForError(
	code: GbpErrorCode,
): GbpConnectionState | null {
	switch (code) {
		case 'gbp_not_verified':
			return 'not_verified'
		case 'gbp_suspended':
			return 'suspended'
		case 'gbp_access_lost':
			return 'access_lost'
		case 'gbp_token_expired':
			return 'token_expired'
		default:
			return null
	}
}

/**
 * Maps a Google HTTP failure to our code. `body` is Google's error JSON when
 * it could be read (its `status` and `message` pick the more precise code).
 */
export function gbpErrorFromResponse(
	status: number,
	body?: { error?: { status?: string; message?: string } } | null,
): GbpError {
	const googleStatus = body?.error?.status ?? ''
	const message = (body?.error?.message ?? '').slice(0, 500)
	const lower = message.toLowerCase()
	if (status === 401) return new GbpError('gbp_token_expired', status, message)
	if (status === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
		return new GbpError('gbp_rate_limited', status, message)
	}
	if (status === 403 || status === 404) {
		if (lower.includes('suspend')) {
			return new GbpError('gbp_suspended', status, message)
		}
		if (lower.includes('verif')) {
			return new GbpError('gbp_not_verified', status, message)
		}
		return new GbpError('gbp_access_lost', status, message)
	}
	if (status === 400 || status === 422 || googleStatus === 'INVALID_ARGUMENT') {
		if (lower.includes('verif')) {
			return new GbpError('gbp_not_verified', status, message)
		}
		return new GbpError('gbp_rejected', status, message)
	}
	return new GbpError('gbp_api_error', status, message)
}

// ---------------------------------------------------------------------------
// Quota: the same field is not retried within an hour
// ---------------------------------------------------------------------------

export const GBP_RETRY_INTERVAL_MS = 60 * 60_000

export type FieldAttempt = {
	fingerprint: string
	attemptedAt: string
	// sent | pending_google | rejected | failed
	status: string
	reason?: string | null
}

export type FieldState = Partial<Record<string, FieldAttempt>>

export function parseFieldState(raw: string | null | undefined): FieldState {
	if (!raw) return {}
	try {
		const parsed: unknown = JSON.parse(raw)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as FieldState)
			: {}
	} catch {
		return {}
	}
}

/**
 * Whether a field's desired value should be sent now. A value already sent
 * (same fingerprint, accepted or still pending review) is not sent again; a
 * rejected or failed attempt is retried only after an hour; a changed value
 * is a new attempt at once.
 */
export function shouldPushField(
	state: FieldState,
	field: string,
	desiredFingerprint: string,
	now: Date,
): boolean {
	const previous = state[field]
	if (!previous) return true
	if (previous.fingerprint !== desiredFingerprint) return true
	if (previous.status === 'sent' || previous.status === 'pending_google') {
		return false
	}
	// A refusal Google explained ("rejected") is not retried by itself.
	if (previous.status === 'rejected') return false
	const attemptedAt = Date.parse(previous.attemptedAt)
	if (Number.isNaN(attemptedAt)) return true
	return now.getTime() - attemptedAt >= GBP_RETRY_INTERVAL_MS
}

// ---------------------------------------------------------------------------
// Ordering pause: when the Google order link is removed
// ---------------------------------------------------------------------------

/** Default threshold: a pause under this does not touch Google. */
export const GBP_PAUSE_LINK_THRESHOLD_MINUTES = 60

/**
 * Whether the order link should be off Google right now. A short pause (under
 * the threshold, default 60 minutes) changes nothing, so the link does not
 * flap; a pause planned for longer removes it, and so does an open-ended pause
 * once it has lasted the threshold.
 */
export function orderLinkShouldBeRemoved(
	location: {
		orderingPausedAt: Date | null
		orderingPausedUntil: Date | null
	},
	now: Date,
	thresholdMinutes = GBP_PAUSE_LINK_THRESHOLD_MINUTES,
): boolean {
	const { orderingPausedAt, orderingPausedUntil } = location
	if (!orderingPausedAt) return false
	if (orderingPausedUntil && orderingPausedUntil.getTime() <= now.getTime()) {
		return false
	}
	const thresholdMs = thresholdMinutes * 60_000
	if (orderingPausedUntil) {
		// A pause with an end is long or short from the start: a short one
		// leaves Google alone, a long one takes the link off at once.
		return (
			orderingPausedUntil.getTime() - orderingPausedAt.getTime() >= thresholdMs
		)
	}
	// "Until I resume": no end to measure, so wait out the threshold.
	return now.getTime() - orderingPausedAt.getTime() >= thresholdMs
}

// ---------------------------------------------------------------------------
// Verification (#284)
// ---------------------------------------------------------------------------

export const VERIFICATION_METHODS = [
	'ADDRESS',
	'PHONE_CALL',
	'SMS',
	'EMAIL',
	'AUTO',
	'VETTED_PARTNER',
] as const
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number]

export type VerificationOption = {
	method: VerificationMethod
	/** Where Google sends the code: an address, a phone number or an email. */
	destination: string | null
	/** Google's own words for an email option (`username@domain`). */
	hint?: string | null
}

export const VERIFICATION_STATES = [
	'unknown',
	'verified',
	'unverified',
	'pending',
] as const
export type VerificationState = (typeof VERIFICATION_STATES)[number]

/** A second postcard cannot be requested within 14 days. */
export const POSTCARD_COOLDOWN_DAYS = 14

export function canRequestPostcard(
	lastRequestedAt: Date | null,
	now: Date,
): boolean {
	if (!lastRequestedAt) return true
	return (
		now.getTime() - lastRequestedAt.getTime() >=
		POSTCARD_COOLDOWN_DAYS * 24 * 60 * 60_000
	)
}

export function nextPostcardAt(lastRequestedAt: Date | null): Date | null {
	if (!lastRequestedAt) return null
	return new Date(
		lastRequestedAt.getTime() + POSTCARD_COOLDOWN_DAYS * 24 * 60 * 60_000,
	)
}

/** Whether a verification attempt is waiting for a code. */
export function isVerificationPending(sync: {
	verificationState: string
}): boolean {
	return sync.verificationState === 'pending'
}

/**
 * Edits that would void a pending postcard code are held: Google asks that
 * name, address and category stay as they were when the postcard was
 * requested. Returns the held fields; the screen says why.
 */
export function heldFieldsWhilePending(
	sync: { verificationState: string; verificationMethod: string | null },
	fields: readonly string[],
): GbpExplicitField[] {
	if (sync.verificationState !== 'pending') return []
	// Only a postcard (or a vetted-partner review) is voided by an edit; a
	// phone or text code is valid minutes later, but the same warning holds
	// for every pending code to keep the rule simple and safe.
	return fields.filter((field): field is GbpExplicitField =>
		(GBP_EXPLICIT_FIELDS as readonly string[]).includes(field),
	)
}

export type VerificationGuide =
	| { kind: 'verified' }
	| { kind: 'choose'; methods: VerificationOption[] }
	| { kind: 'enter_code'; method: VerificationMethod | null }
	| { kind: 'managed_elsewhere' }
	| { kind: 'suspended' }
	| { kind: 'no_method' }
	| { kind: 'unknown' }

/**
 * What the verification card should show. `options` is null when Google was
 * not asked or answered nothing; `connectionState` carries the cases that are
 * not ours to fix.
 */
export function verificationGuide(input: {
	verificationState: string
	connectionState: string
	options: VerificationOption[] | null
	alreadyHasCode?: boolean
}): VerificationGuide {
	if (input.verificationState === 'verified') return { kind: 'verified' }
	if (input.connectionState === 'suspended') return { kind: 'suspended' }
	if (input.connectionState === 'access_lost') {
		return { kind: 'managed_elsewhere' }
	}
	if (input.verificationState === 'pending' || input.alreadyHasCode) {
		return { kind: 'enter_code', method: null }
	}
	if (input.verificationState === 'unverified') {
		if (!input.options || input.options.length === 0)
			return { kind: 'no_method' }
		return { kind: 'choose', methods: input.options }
	}
	return { kind: 'unknown' }
}

// ---------------------------------------------------------------------------
// Profile description and attributes (#209)
// ---------------------------------------------------------------------------

/** Google's limit for the business description. */
export const GBP_DESCRIPTION_MAX = 750

export type DescriptionProblem = 'too_long' | 'has_link' | 'has_phone'

const URL_PATTERN =
	/(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|net|org|io|co|sa|ae|uk)\b/i
const PHONE_PATTERN = /(\+?\d[\d\s().-]{6,}\d)/

export function descriptionProblems(text: string): DescriptionProblem[] {
	const problems: DescriptionProblem[] = []
	if ([...text].length > GBP_DESCRIPTION_MAX) problems.push('too_long')
	if (URL_PATTERN.test(text)) problems.push('has_link')
	if (PHONE_PATTERN.test(text)) problems.push('has_phone')
	return problems
}

export type FulfillmentSource = {
	pickup?: boolean
	delivery?: boolean
	dineIn?: boolean
	curbside?: boolean
}

/**
 * Google attribute ids Menuza can derive. `value` is the boolean to set;
 * only attributes Google lists for the profile's category are sent.
 */
export const DERIVED_ATTRIBUTES = {
	'attributes/has_delivery': 'Delivery',
	'attributes/has_takeout': 'Takeout',
	'attributes/has_curbside_pickup': 'Curbside pickup',
	'attributes/has_dine_in': 'Dine-in',
	'attributes/accepts_reservations': 'Accepts reservations',
	'attributes/pay_credit_card': 'Accepts credit cards',
} as const
export type DerivedAttributeName = keyof typeof DERIVED_ATTRIBUTES

export function deriveAttributes(input: {
	fulfillment: FulfillmentSource | null
	reservationsEnabled: boolean
	onlinePaymentsConnected: boolean
}): Record<DerivedAttributeName, boolean> {
	const options = input.fulfillment ?? {}
	return {
		'attributes/has_delivery': options.delivery === true,
		'attributes/has_takeout': options.pickup === true,
		'attributes/has_curbside_pickup': options.curbside === true,
		'attributes/has_dine_in': options.dineIn === true,
		'attributes/accepts_reservations': input.reservationsEnabled,
		'attributes/pay_credit_card': input.onlinePaymentsConnected,
	}
}

export const ATTRIBUTE_GROUPS = [
	'service_options',
	'dining_options',
	'accessibility',
	'payments',
	'offerings',
	'other',
] as const
export type AttributeGroup = (typeof ATTRIBUTE_GROUPS)[number]

/** Sorts a Google attribute into Menuza's groups by its name. */
export function attributeGroup(name: string): AttributeGroup {
	const key = name.replace(/^attributes\//, '')
	if (
		/^(has_delivery|has_takeout|has_curbside|has_dine_in|has_drive_through|has_onsite|offers_)/.test(
			key,
		)
	) {
		return 'service_options'
	}
	if (
		/(reservation|seating|outdoor|dining|serves_|good_for|has_bar|has_live)/.test(
			key,
		)
	) {
		return 'dining_options'
	}
	if (/(wheelchair|accessib|has_restroom|gender_neutral)/.test(key)) {
		return 'accessibility'
	}
	if (/^pay_|(credit|debit|nfc|cash|check)/.test(key)) return 'payments'
	if (/(halal|kosher|vegan|vegetarian|gluten|organic|serves_|menu)/.test(key)) {
		return 'offerings'
	}
	return 'other'
}

export type GoogleAttributeMeta = {
	name: string
	displayName: string
	groupDisplayName?: string
	valueType: 'BOOL' | 'ENUM' | 'REPEATED_ENUM' | 'URL' | string
	deprecated?: boolean
}

export type AttributeValue = boolean | null

export type AttributeSuggestion = {
	name: string
	displayName: string
	menuza: boolean
	google: boolean | null
}

/**
 * "Suggested changes": derived attributes where Menuza and Google differ,
 * limited to attributes Google lists for this profile.
 */
export function suggestAttributeChanges(
	derived: Record<string, boolean>,
	google: Record<string, boolean | null>,
	available: readonly GoogleAttributeMeta[],
): AttributeSuggestion[] {
	const out: AttributeSuggestion[] = []
	for (const meta of available) {
		if (meta.deprecated || meta.valueType !== 'BOOL') continue
		const menuza = derived[meta.name]
		if (menuza === undefined) continue
		const theirs = google[meta.name] ?? null
		if (theirs !== menuza) {
			out.push({
				name: meta.name,
				displayName: meta.displayName,
				menuza,
				google: theirs,
			})
		}
	}
	return out
}
