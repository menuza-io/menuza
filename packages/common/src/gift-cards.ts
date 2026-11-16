/**
 * Gift cards: the shared domain code for App, tenant-api, Sites, Station and
 * the customer app. No UI strings and no I/O.
 *
 * A card is a ledger (`gift_card_ledger` in the regional tenant database): the
 * balance is the sum of its entries and is never stored as a free number. The
 * control plane keeps flags, permissions and settings only; codes, balances
 * and purchaser/recipient details stay in the region.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/**
 * ConfigFlag keys. Every flag defaults to off and only a literal `true` counts.
 * `gift_cards.enabled` is the master: the children read as off without it.
 */
export const GIFT_CARD_FLAG_KEYS = {
	enabled: 'gift_cards.enabled',
	online: 'gift_cards.online',
	pos: 'gift_cards.pos',
} as const

export type GiftCardFlagName = keyof typeof GIFT_CARD_FLAG_KEYS

export type GiftCardFeatures = {
	/** The master: App screens, balance reads, adjusting, charging. */
	enabled: boolean
	/** Sites purchase and checkout redemption. */
	online: boolean
	/** Station sell, top up, redeem and activate. */
	pos: boolean
}

export const GIFT_CARD_FEATURES_OFF: Readonly<GiftCardFeatures> = Object.freeze(
	{ enabled: false, online: false, pos: false },
)

export const giftCardFeaturesSchema = z
	.object({ enabled: z.boolean(), online: z.boolean(), pos: z.boolean() })
	.strict()

export function foldGiftCardFeatures(
	raw: Partial<Record<GiftCardFlagName, unknown>>,
): GiftCardFeatures {
	const enabled = raw.enabled === true
	return {
		enabled,
		online: enabled && raw.online === true,
		pos: enabled && raw.pos === true,
	}
}

/** Reads features from an untrusted payload; anything malformed reads as off. */
export function readGiftCardFeatures(raw: unknown): GiftCardFeatures {
	const parsed = giftCardFeaturesSchema.safeParse(raw)
	if (!parsed.success) return { ...GIFT_CARD_FEATURES_OFF }
	return foldGiftCardFeatures(parsed.data)
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Kept in sync with `ORG_PERMISSIONS` in `@repo/auth`, `setup-roles.ts` and the
 * control-plane migration that seeds them.
 */
export const GIFT_CARD_PERMISSIONS = {
	/** List cards and read their history and the reports. */
	READ_GIFT_CARD: 'read:gift_card:any',
	/** Adjust, void, review held cards, import, card stock. */
	UPDATE_GIFT_CARD: 'update:gift_card:any',
	/** Charge a card from the App (#215) without being able to adjust freely. */
	UPDATE_GIFT_CARD_CHARGE: 'update:gift_card_charge:any',
} as const

export type GiftCardPermission =
	(typeof GIFT_CARD_PERMISSIONS)[keyof typeof GIFT_CARD_PERMISSIONS]

export const GIFT_CARD_PERMISSION_LIST: readonly GiftCardPermission[] =
	Object.values(GIFT_CARD_PERMISSIONS)

export function isGiftCardPermission(
	value: string,
): value is GiftCardPermission {
	return (GIFT_CARD_PERMISSION_LIST as readonly string[]).includes(value)
}

/** Every `update:` grant implies reading cards. */
export function expandGiftCardGrants(
	held: readonly string[],
): GiftCardPermission[] {
	const set = new Set<GiftCardPermission>()
	for (const grant of held) {
		if (!isGiftCardPermission(grant)) continue
		set.add(grant)
		if (grant.startsWith('update:')) set.add(GIFT_CARD_PERMISSIONS.READ_GIFT_CARD)
	}
	return GIFT_CARD_PERMISSION_LIST.filter((permission) => set.has(permission))
}

/** Support impersonation may look but never change or charge anything. */
export function restrictGiftCardGrantsForImpersonation(
	grants: readonly GiftCardPermission[],
	impersonated: boolean,
): GiftCardPermission[] {
	if (!impersonated) return [...grants]
	return grants.filter((grant) => !grant.startsWith('update:'))
}

export function hasGiftCardGrant(
	held: readonly string[],
	required: GiftCardPermission,
): boolean {
	return expandGiftCardGrants(held).includes(required)
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * `pending`: bought online, not paid yet. `inactive`: a printed card that has
 * not been sold. `held`: paid, waiting for the delivery delay or a review.
 * `frozen`: a disputed purchase. Only `active` cards can be spent.
 */
export const GIFT_CARD_STATUSES = [
	'pending',
	'inactive',
	'active',
	'held',
	'frozen',
	'voided',
	'expired',
] as const
export type GiftCardStatus = (typeof GIFT_CARD_STATUSES)[number]

export const GIFT_CARD_SOURCES = ['online', 'pos', 'import', 'print'] as const
export type GiftCardSource = (typeof GIFT_CARD_SOURCES)[number]

export const GIFT_CARD_LEDGER_KINDS = [
	'issue',
	'top_up',
	'redeem',
	'refund',
	'adjust',
	'void',
	'import',
	'dispute_removal',
] as const
export type GiftCardLedgerKind = (typeof GIFT_CARD_LEDGER_KINDS)[number]

export const GIFT_CARD_SOURCE_TYPES = [
	'restaurant_order',
	'pos_order',
	'purchase',
	'adjust',
	'import',
	'manual_charge',
	'system',
] as const
export type GiftCardSourceType = (typeof GIFT_CARD_SOURCE_TYPES)[number]

export const GIFT_CARD_CHANNELS = [
	'online',
	'pos',
	'app',
	'import',
	'system',
] as const
export type GiftCardChannel = (typeof GIFT_CARD_CHANNELS)[number]

export const GIFT_CARD_HOLD_REASONS = [
	'first_buyer',
	'provider_risk',
	'manual',
] as const
export type GiftCardHoldReason = (typeof GIFT_CARD_HOLD_REASONS)[number]

/** Whether a ledger amount has the sign its kind requires. */
export function giftCardLedgerSignOk(
	kind: GiftCardLedgerKind,
	amountMinor: number,
): boolean {
	switch (kind) {
		case 'issue':
		case 'top_up':
		case 'refund':
			return amountMinor > 0
		case 'import':
			return amountMinor >= 0
		case 'redeem':
		case 'void':
		case 'dispute_removal':
			return amountMinor < 0
		case 'adjust':
			return amountMinor !== 0
	}
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/** Crockford base32 without I, L, O and U: nothing to misread. */
export const GIFT_CARD_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const GIFT_CARD_CODE_LENGTH = 16
/** An original number from another system: digits only. */
export const GIFT_CARD_EXTERNAL_MIN_DIGITS = 16
export const GIFT_CARD_EXTERNAL_MAX_DIGITS = 32

function randomIndexes(count: number, modulo: number): number[] {
	const out: number[] = []
	// Rejection sampling keeps every symbol equally likely.
	const limit = 256 - (256 % modulo)
	while (out.length < count) {
		const bytes = new Uint8Array(count * 2)
		crypto.getRandomValues(bytes)
		for (const byte of bytes) {
			if (byte < limit) out.push(byte % modulo)
			if (out.length === count) break
		}
	}
	return out
}

export function generateGiftCardCode(): string {
	return randomIndexes(GIFT_CARD_CODE_LENGTH, GIFT_CARD_CODE_ALPHABET.length)
		.map((index) => GIFT_CARD_CODE_ALPHABET[index])
		.join('')
}

/** `ABCD-EFGH-JKMN-PQRS` for display. */
export function formatGiftCardCode(code: string): string {
	return code.match(/.{1,4}/g)?.join('-') ?? code
}

/**
 * Reads a typed or scanned Menuza code: case, spaces and dashes do not matter,
 * and O, I and L read as the digits they are mistaken for.
 */
export function normalizeGiftCardCode(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 48) return null
	const cleaned = value
		.toUpperCase()
		.replace(/[\s-]/g, '')
		.replace(/O/g, '0')
		.replace(/[IL]/g, '1')
	if (cleaned.length !== GIFT_CARD_CODE_LENGTH) return null
	for (const char of cleaned) {
		if (!GIFT_CARD_CODE_ALPHABET.includes(char)) return null
	}
	return cleaned
}

/** An original card number from another system, or null when not one. */
export function normalizeExternalCardNumber(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 64) return null
	const cleaned = value.replace(/[\s-]/g, '')
	if (!/^\d+$/.test(cleaned)) return null
	if (
		cleaned.length < GIFT_CARD_EXTERNAL_MIN_DIGITS ||
		cleaned.length > GIFT_CARD_EXTERNAL_MAX_DIGITS
	) {
		return null
	}
	return cleaned
}

export function giftCardLast4(code: string): string {
	return code.slice(-4)
}

/** Short-lived show token for the till QR (#217): not the card code. */
export const GIFT_CARD_SHOW_TOKEN_TTL_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// Money rules
// ---------------------------------------------------------------------------

/** The largest amount any one card entry may carry (minor units). */
export const GIFT_CARD_MAX_ENTRY_MINOR = 10_000_000

export function isGiftCardMinorAmount(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= GIFT_CARD_MAX_ENTRY_MINOR
	)
}

/**
 * What a card can take off an order: never more than the balance, never more
 * than what is still to pay.
 */
export function giftCardRedeemableMinor(
	balanceMinor: number,
	dueMinor: number,
): number {
	return Math.max(0, Math.min(balanceMinor, dueMinor))
}

/** The balance is the sum of the entries; nothing else. */
export function sumGiftCardLedger(
	entries: readonly { amountMinor: number }[],
): number {
	let sum = 0
	for (const entry of entries) sum += entry.amountMinor
	return sum
}

/** `active` past its expiry reads as `expired`. */
export function effectiveGiftCardStatus(
	card: { status: GiftCardStatus; expiresAt: number | null },
	now: number,
): GiftCardStatus {
	if (card.status === 'active' && card.expiresAt !== null && card.expiresAt <= now) {
		return 'expired'
	}
	return card.status
}

/** A balance a guest may see: 0 while the card cannot be spent. */
export function visibleGiftCardBalance(
	status: GiftCardStatus,
	balanceMinor: number,
): number {
	return status === 'active' || status === 'held' ? Math.max(0, balanceMinor) : 0
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const GIFT_CARD_ERROR_CODES = [
	'gift_cards_unavailable',
	'gift_cards_disabled',
	'feature_disabled',
	'unauthorized',
	'forbidden',
	'location_forbidden',
	'not_found',
	'invalid_request',
	'code_invalid',
	'rate_limited',
	'gift_card_balance_low',
	'gift_card_not_active',
	'gift_card_inactive',
	'gift_card_expired',
	'gift_card_voided',
	'gift_card_held',
	'gift_card_frozen',
	'currency_mismatch',
	'idempotency_conflict',
	'stale_balance',
	'gift_card_refund_exceeds_charge',
	'amount_out_of_range',
	'purchase_limit',
	'gift_card_changed',
	'offline_not_supported',
	'already_active',
	'already_claimed',
	'not_held',
	'reader_not_configured',
	'import_invalid',
	'review_not_needed',
	'refund_exceeds_unspent',
] as const
export type GiftCardErrorCode = (typeof GIFT_CARD_ERROR_CODES)[number]

export const GIFT_CARD_ERROR_HTTP_STATUS: Readonly<
	Record<GiftCardErrorCode, number>
> = {
	gift_cards_unavailable: 503,
	gift_cards_disabled: 403,
	feature_disabled: 403,
	unauthorized: 401,
	forbidden: 403,
	location_forbidden: 403,
	not_found: 404,
	invalid_request: 400,
	code_invalid: 404,
	rate_limited: 429,
	gift_card_balance_low: 409,
	gift_card_not_active: 409,
	gift_card_inactive: 409,
	gift_card_expired: 409,
	gift_card_voided: 409,
	gift_card_held: 409,
	gift_card_frozen: 409,
	currency_mismatch: 422,
	idempotency_conflict: 409,
	stale_balance: 409,
	gift_card_refund_exceeds_charge: 409,
	amount_out_of_range: 422,
	purchase_limit: 422,
	gift_card_changed: 409,
	offline_not_supported: 409,
	already_active: 409,
	already_claimed: 409,
	not_held: 409,
	reader_not_configured: 503,
	import_invalid: 422,
	review_not_needed: 409,
	refund_exceeds_unspent: 409,
}

export class GiftCardDomainError extends Error {
	readonly code: GiftCardErrorCode
	readonly details: Record<string, unknown>
	constructor(code: GiftCardErrorCode, details: Record<string, unknown> = {}) {
		super(code)
		this.name = 'GiftCardDomainError'
		this.code = code
		this.details = details
	}
	get status(): number {
		return GIFT_CARD_ERROR_HTTP_STATUS[this.code]
	}
}

// ---------------------------------------------------------------------------
// Operator token (`gft+jwt`)
// ---------------------------------------------------------------------------

export const GIFT_CARD_TOKEN_AUDIENCE = 'tenant-api-gift-cards-operator' as const
export const GIFT_CARD_TOKEN_TYP = 'gft+jwt' as const
export const GIFT_CARD_TOKEN_MAX_TTL_SECONDS = 15 * 60
export const GIFT_CARD_TOKEN_IMPERSONATED_TTL_SECONDS = 5 * 60

export const GIFT_CARD_SCOPES = ['read', 'write'] as const
export type GiftCardScope = (typeof GIFT_CARD_SCOPES)[number]

/** Grants a token of each scope may carry (a subset of what the member holds). */
export const GIFT_CARD_SCOPE_GRANTS: Readonly<
	Record<GiftCardScope, readonly GiftCardPermission[]>
> = {
	read: [GIFT_CARD_PERMISSIONS.READ_GIFT_CARD],
	write: GIFT_CARD_PERMISSION_LIST,
}

export function giftCardTokenTtlSeconds(impersonated: boolean): number {
	return impersonated
		? GIFT_CARD_TOKEN_IMPERSONATED_TTL_SECONDS
		: GIFT_CARD_TOKEN_MAX_TTL_SECONDS
}

/** The grants a token for `scope` gets from what the member holds. */
export function giftCardScopeGrantsFor(
	scope: GiftCardScope,
	held: readonly string[],
	impersonated = false,
): GiftCardPermission[] {
	const safe = restrictGiftCardGrantsForImpersonation(
		expandGiftCardGrants(held),
		impersonated,
	)
	const allowed = new Set<GiftCardPermission>(GIFT_CARD_SCOPE_GRANTS[scope])
	return safe.filter((grant) => allowed.has(grant))
}

const locationIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'Invalid location ID')

export const giftCardTokenClaimsSchema = z
	.object({
		aud: z.literal(GIFT_CARD_TOKEN_AUDIENCE),
		iss: z.string().min(1).max(120).optional(),
		role: z.literal('operator'),
		region: z.enum(['us', 'ksa']),
		orgId: z.string().min(1).max(64),
		sub: z.string().min(1).max(64),
		/** The named operator, kept on adjustments and charges. */
		actorName: z.string().max(120).optional(),
		scope: z.enum(GIFT_CARD_SCOPES),
		grants: z
			.array(z.enum(GIFT_CARD_PERMISSION_LIST as [GiftCardPermission, ...GiftCardPermission[]]))
			.min(1)
			.max(3),
		/** `null` allows every location; `[]` none. */
		locationIds: z.array(locationIdSchema).max(200).nullable(),
		features: giftCardFeaturesSchema,
		impersonated: z.boolean(),
		iat: z.number().int().positive(),
		exp: z.number().int().positive(),
	})
	.strict()
	.superRefine((claims, ctx) => {
		const ttl = claims.exp - claims.iat
		if (ttl <= 0) {
			ctx.addIssue({
				code: 'custom',
				path: ['exp'],
				message: 'Token expiration must be after issued-at time',
			})
			return
		}
		const maxTtl = giftCardTokenTtlSeconds(claims.impersonated)
		if (ttl > maxTtl) {
			ctx.addIssue({
				code: 'custom',
				path: ['exp'],
				message: `Token TTL exceeds the maximum of ${maxTtl}s`,
			})
		}
		if (
			claims.impersonated &&
			claims.grants.some((grant) => grant.startsWith('update:'))
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['grants'],
				message: 'Impersonated tokens cannot hold write grants',
			})
		}
		const allowed = new Set<string>(GIFT_CARD_SCOPE_GRANTS[claims.scope])
		if (claims.grants.some((grant) => !allowed.has(grant))) {
			ctx.addIssue({
				code: 'custom',
				path: ['grants'],
				message: 'A grant is not valid for the token scope',
			})
		}
		if (new Set(claims.grants).size !== claims.grants.length) {
			ctx.addIssue({ code: 'custom', path: ['grants'], message: 'Duplicate grant' })
		}
	})

export type GiftCardTokenClaims = z.infer<typeof giftCardTokenClaimsSchema>

/** `null` allows every location; `[]` allows none. */
export function giftCardAllowsLocation(
	locationIds: readonly string[] | null,
	locationId: string,
): boolean {
	return locationIds === null || locationIds.includes(locationId)
}

// ---------------------------------------------------------------------------
// Settings (control plane) and the context the region reads
// ---------------------------------------------------------------------------

/** Ready designs (#214). `custom` is an uploaded image from the media library. */
export const GIFT_CARD_DESIGN_KEYS = [
	'classic',
	'birthday',
	'holidays',
	'thank_you',
	'eid',
	'ramadan',
	'national_day',
	'custom',
] as const
export type GiftCardDesignKey = (typeof GIFT_CARD_DESIGN_KEYS)[number]
export const giftCardDesignKeySchema = z.enum(GIFT_CARD_DESIGN_KEYS)

/** An uploaded design's file rules. */
export const GIFT_CARD_CUSTOM_IMAGE_TYPES = [
	'image/png',
	'image/jpeg',
	'image/webp',
] as const
export const GIFT_CARD_CUSTOM_IMAGE_MAX_BYTES = 2 * 1024 * 1024

export const giftCardDesignSettingSchema = z
	.object({
		key: giftCardDesignKeySchema,
		enabled: z.boolean(),
		/** Media library key of the uploaded image, for `custom`. */
		imageKey: z.string().min(1).max(200).nullable().optional(),
	})
	.strict()
export type GiftCardDesignSetting = z.infer<typeof giftCardDesignSettingSchema>

/**
 * Purchase limits (#218). Safe defaults; amounts are in major units of the
 * organization's currency so one table serves US and KSA.
 */
export const giftCardLimitsSchema = z
	.object({
		/** The largest card (major units). */
		maxCardMajor: z.number().int().min(1).max(100_000),
		/** The most one purchase may carry (major units). */
		maxPerPurchaseMajor: z.number().int().min(1).max(100_000),
		/** Purchases per payment card / buyer email / device in 24 hours. */
		maxPurchasesPer24h: z.number().int().min(1).max(100),
		/** A first-time buyer's immediate card at or above this is held (major). */
		holdThresholdMajor: z.number().int().min(1).max(100_000),
		/** How long such a card is held. */
		holdHours: z.number().int().min(1).max(72),
		/** This many purchases from one device in an hour alert the managers. */
		burstPerHour: z.number().int().min(2).max(100),
	})
	.strict()
export type GiftCardLimits = z.infer<typeof giftCardLimitsSchema>

export const DEFAULT_GIFT_CARD_LIMITS: Readonly<GiftCardLimits> = Object.freeze({
	maxCardMajor: 500,
	maxPerPurchaseMajor: 500,
	maxPurchasesPer24h: 3,
	holdThresholdMajor: 100,
	holdHours: 2,
	burstPerHour: 5,
})

export const giftCardSettingsSchema = z
	.object({
		/** Preset amounts in minor units. */
		presetsMinor: z.array(z.number().int().min(1)).max(8),
		minAmountMinor: z.number().int().min(1),
		maxAmountMinor: z.number().int().min(1),
		allowCustomAmount: z.boolean(),
		/** Months until a card expires; null = never (the default). */
		expiryMonths: z.number().int().min(1).max(120).nullable(),
		designs: z.array(giftCardDesignSettingSchema).max(GIFT_CARD_DESIGN_KEYS.length),
		defaultDesign: giftCardDesignKeySchema,
		/** The location online sales belong to when the buyer chose none. */
		defaultLocationId: z.string().min(1).max(64).nullable(),
		limits: giftCardLimitsSchema,
	})
	.strict()
export type GiftCardSettings = z.infer<typeof giftCardSettingsSchema>

export const DEFAULT_GIFT_CARD_PRESETS_MINOR = [2500, 5000, 10000] as const

export function defaultGiftCardSettings(): GiftCardSettings {
	return {
		presetsMinor: [...DEFAULT_GIFT_CARD_PRESETS_MINOR],
		minAmountMinor: 1000,
		maxAmountMinor: 50000,
		allowCustomAmount: true,
		expiryMonths: null,
		designs: GIFT_CARD_DESIGN_KEYS.filter((key) => key !== 'custom').map(
			(key) => ({ key, enabled: key === 'classic', imageKey: null }),
		),
		defaultDesign: 'classic',
		defaultLocationId: null,
		limits: { ...DEFAULT_GIFT_CARD_LIMITS },
	}
}

/**
 * Normalizes untrusted settings: limits can never exceed the card bounds, the
 * default design is always an enabled one.
 */
export function readGiftCardSettings(raw: unknown): GiftCardSettings {
	const parsed = giftCardSettingsSchema.safeParse(raw)
	const base = parsed.success ? parsed.data : defaultGiftCardSettings()
	const enabled = base.designs.filter((design) => design.enabled)
	const defaultDesign = enabled.some((d) => d.key === base.defaultDesign)
		? base.defaultDesign
		: (enabled[0]?.key ?? 'classic')
	return { ...base, defaultDesign }
}

export function enabledGiftCardDesigns(
	settings: Pick<GiftCardSettings, 'designs'>,
): GiftCardDesignSetting[] {
	return settings.designs.filter((design) => design.enabled)
}

/** What the US App tells a region about an organization. */
export const giftCardContextSchema = z.object({
	orgId: z.string().min(1).max(64),
	features: giftCardFeaturesSchema,
	settings: giftCardSettingsSchema.optional(),
	currency: z
		.string()
		.regex(/^[A-Z]{3}$/)
		.optional(),
	locations: z
		.array(
			z.object({
				id: z.string().min(1).max(64),
				name: z.string().max(120).optional(),
				currency: z
					.string()
					.regex(/^[A-Z]{3}$/)
					.nullable()
					.optional(),
				timeZone: z.string().min(1).max(64).nullable().optional(),
			}),
		)
		.max(500)
		.optional(),
})
export type GiftCardContext = z.infer<typeof giftCardContextSchema>
