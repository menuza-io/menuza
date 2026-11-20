import { z } from 'zod'

/**
 * Branded customer app registry: the pure rules shared by Admin, App, jobs and
 * tenant-api (#156, #196, #105). No I/O, no UI strings.
 *
 * One record per organization (`CustomerApp`, control plane). It holds public
 * branding, bundle ids and store links only; never guest data. Push
 * credentials live in `CustomerAppCredential`, encrypted and write-only.
 */

export const CUSTOMER_APP_FLAGS = {
	/** Shows the read-only "Customer app" card in the restaurant's Settings. */
	enabled: 'customer_app.enabled',
	/** Guest push notifications (#105). Default off; stays off for KSA until legal approves. */
	push: 'customer_app.push',
} as const

/** Marketing push (broadcasts and automations) also needs this (#105). */
export const MARKETING_PUSH_FLAG = 'marketing.push'

/** Admin permission: create apps, upload credentials, start builds. */
export const CUSTOMER_APP_PERMISSION = 'update:customer_app:any' as const

export const CUSTOMER_APP_STORES = ['app_store', 'play_store'] as const
export type CustomerAppStore = (typeof CUSTOMER_APP_STORES)[number]

export const CUSTOMER_APP_PLATFORMS = ['ios', 'android'] as const
export type CustomerAppPlatform = (typeof CUSTOMER_APP_PLATFORMS)[number]

export const STORE_FOR_PLATFORM: Record<CustomerAppPlatform, CustomerAppStore> =
	{ ios: 'app_store', android: 'play_store' }
export const PLATFORM_FOR_STORE: Record<CustomerAppStore, CustomerAppPlatform> =
	{ app_store: 'ios', play_store: 'android' }

export const CUSTOMER_APP_STATUSES = ['draft', 'published', 'archived'] as const
export type CustomerAppStatus = (typeof CUSTOMER_APP_STATUSES)[number]

export const CUSTOMER_APP_BUILD_STATUSES = [
	'queued',
	'running',
	'succeeded',
	'failed',
	'cancelled',
] as const
export type CustomerAppBuildStatus =
	(typeof CUSTOMER_APP_BUILD_STATUSES)[number]

export const CUSTOMER_APP_STORE_STATUSES = [
	'live',
	'removed',
	'unknown',
] as const
export type CustomerAppStoreStatus =
	(typeof CUSTOMER_APP_STORE_STATUSES)[number]

export const CUSTOMER_APP_CREDENTIAL_KINDS = ['apns', 'fcm'] as const
export type CustomerAppCredentialKind =
	(typeof CUSTOMER_APP_CREDENTIAL_KINDS)[number]

/** Where the app is published: Menuza's own developer account, or the restaurant's. */
export const CUSTOMER_APP_PUBLISHERS = ['menuza', 'restaurant'] as const
export type CustomerAppPublisher = (typeof CUSTOMER_APP_PUBLISHERS)[number]

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const CUSTOMER_APP_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
/** iOS bundle id: reverse-DNS, letters, digits and hyphens. */
export const IOS_BUNDLE_ID = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/
/** Android application id: dot-separated Java identifiers. */
export const ANDROID_PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
export const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/
export const ANDROID_SHA256 = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/
export const MARKETING_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/

export const iosBundleIdSchema = z
	.string()
	.trim()
	.min(3)
	.max(155)
	.regex(IOS_BUNDLE_ID, {
		error: 'Use a reverse-domain id such as com.acme.app',
	})
export const androidPackageSchema = z
	.string()
	.trim()
	.min(3)
	.max(155)
	.regex(ANDROID_PACKAGE, {
		error: 'Use lowercase segments such as com.acme.app',
	})
export const customerAppSlugSchema = z
	.string()
	.trim()
	.toLowerCase()
	.regex(CUSTOMER_APP_SLUG, {
		error: 'Use lowercase letters, digits and hyphens',
	})

/** Store listing name limit (App Store 30 characters, Play 30). */
export const DISPLAY_NAME_MAX = 30
export const displayNameSchema = z.string().trim().min(1).max(DISPLAY_NAME_MAX)
export const marketingVersionSchema = z
	.string()
	.trim()
	.regex(MARKETING_VERSION, { error: 'Use a version such as 1.2.0' })

/** Hex colour used for the Android adaptive icon background. */
export const iconBackgroundSchema = z
	.string()
	.trim()
	.regex(/^#[0-9a-fA-F]{6}$/, { error: 'Use a hex colour such as #0F172A' })

const APP_STORE_HOSTS = new Set(['apps.apple.com', 'itunes.apple.com'])

/** A store link we are willing to put on a public page or in an email. */
export function parseStoreUrl(
	store: CustomerAppStore,
	raw: unknown,
): string | null {
	if (typeof raw !== 'string') return null
	let url: URL
	try {
		url = new URL(raw.trim())
	} catch {
		return null
	}
	if (url.protocol !== 'https:' || url.username || url.password) return null
	if (store === 'app_store') {
		return APP_STORE_HOSTS.has(url.hostname) && url.pathname.length > 1
			? url.toString()
			: null
	}
	return url.hostname === 'play.google.com' &&
		url.pathname.startsWith('/store/apps/') &&
		/^[A-Za-z0-9._]+$/.test(url.searchParams.get('id') ?? '')
		? url.toString()
		: null
}

export const storeUrlsSchema = z
	.object({
		app_store: z.string().nullish(),
		play_store: z.string().nullish(),
	})
	.transform((value, ctx) => {
		const result: Partial<Record<CustomerAppStore, string>> = {}
		for (const store of CUSTOMER_APP_STORES) {
			const raw = value[store]
			if (raw === null || raw === undefined || raw === '') continue
			const parsed = parseStoreUrl(store, raw)
			if (!parsed) {
				ctx.addIssue({
					code: 'custom',
					path: [store],
					message: 'Not a valid store link',
				})
				return z.NEVER
			}
			result[store] = parsed
		}
		return result
	})
export type StoreUrls = Partial<Record<CustomerAppStore, string>>

/** The tolerant reader for the stored JSON column. */
export function readStoreUrls(raw: string | null | undefined): StoreUrls {
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		const result: StoreUrls = {}
		for (const store of CUSTOMER_APP_STORES) {
			const url = parseStoreUrl(store, parsed?.[store])
			if (url) result[store] = url
		}
		return result
	} catch {
		return {}
	}
}

// ---------------------------------------------------------------------------
// Rules: lifecycle
// ---------------------------------------------------------------------------

export type AppLifecycle = {
	status: CustomerAppStatus
	publishedAt: Date | number | null
}

/** Bundle ids and the package are immutable once an app was published. */
export function identifiersLocked(app: AppLifecycle): boolean {
	return app.publishedAt !== null && app.publishedAt !== undefined
}

/** Deleting is allowed only before the first publish; afterwards archive. */
export function canDeleteApp(app: AppLifecycle): boolean {
	return !identifiersLocked(app)
}

/** Archived apps take no builds, no health checks and show nothing to guests. */
export function canBuildApp(app: AppLifecycle): boolean {
	return app.status !== 'archived'
}

// ---------------------------------------------------------------------------
// Store health, live stores
// ---------------------------------------------------------------------------

export type StoreHealthRow = {
	store: CustomerAppStore
	status: CustomerAppStoreStatus
	version: string | null
	/** Stars times 100 (4.5 stars is 450), or null when the store has none yet. */
	ratingX100: number | null
	ratingCount: number
	lastCheckedAt: Date | number | null
}

export function formatRating(ratingX100: number | null): string | null {
	if (ratingX100 === null || ratingX100 === undefined) return null
	return (ratingX100 / 100).toFixed(1)
}

/**
 * The stores guests may be sent to: a store link is on the record AND the last
 * known state of that store is live. Nothing shows until one qualifies (#196).
 * A store that could not be reached keeps its last known state, so a
 * temporary outage never hides a live listing.
 */
export function liveStores(input: {
	status: CustomerAppStatus
	storeUrls: StoreUrls
	health: Array<Pick<StoreHealthRow, 'store' | 'status'>>
}): StoreUrls {
	if (input.status === 'archived') return {}
	const live: StoreUrls = {}
	for (const store of CUSTOMER_APP_STORES) {
		const url = input.storeUrls[store]
		if (!url) continue
		const health = input.health.find((row) => row.store === store)
		if (health?.status === 'live') live[store] = url
	}
	return live
}

// ---------------------------------------------------------------------------
// Invite placements (#196)
// ---------------------------------------------------------------------------

export const INVITE_PLACEMENTS = [
	'banner',
	'confirmation',
	'email',
	'footer',
	'block',
	'print',
] as const
export type InvitePlacement = (typeof INVITE_PLACEMENTS)[number]

/** Placements an owner switches on or off (the others follow the page that hosts them). */
export const INVITE_SWITCHES = ['banner', 'confirmation', 'footer'] as const

export type InviteSettings = {
	banner: boolean
	confirmation: boolean
	footer: boolean
	/** Owner's banner text; empty uses the default wording. */
	bannerText: string
}

export const INVITE_BANNER_TEXT_MAX = 90
export const DEFAULT_INVITE_SETTINGS: InviteSettings = {
	banner: true,
	confirmation: true,
	footer: true,
	bannerText: '',
}

export const inviteSettingsSchema = z.object({
	banner: z.boolean(),
	confirmation: z.boolean(),
	footer: z.boolean(),
	bannerText: z.string().trim().max(INVITE_BANNER_TEXT_MAX),
})

export const TAP_STORES = CUSTOMER_APP_STORES
export const tapSchema = z.object({
	placement: z.enum(INVITE_PLACEMENTS),
	store: z.enum(CUSTOMER_APP_STORES),
})

/** Days a dismissed banner stays hidden on that device. */
export const INVITE_BANNER_DISMISS_DAYS = 30

// ---------------------------------------------------------------------------
// Build configuration (the file `tenants/<slug>.json` used to hold)
// ---------------------------------------------------------------------------

export type TenantApiEndpoints = {
	appUrl: string
	brandDomain: string
	tenantApiUs: string
	tenantApiKsa: string
}

export type BuildConfigApp = {
	slug: string
	displayName: string
	iosBundleId: string
	androidPackage: string
	marketingVersion: string
	iconBackground: string
	appleTeamId: string | null
	androidSha256: string[]
	status: CustomerAppStatus
}

export type BuildConfigOrganization = {
	slug: string
	dataRegion: string
	/** The published site's primary host (custom domain or `<slug>.<apex>`), no scheme. */
	siteHost: string
	siteOrigin: string
	iconUrl: string | null
}

export type CustomerAppBuildConfig = {
	slug: string
	displayName: string
	bundleId: string
	androidPackage: string
	marketingVersion: string
	appUrl: string
	brandDomain: string
	/** Only the organization's own region is filled; a region change needs a new build. */
	tenantApiUs: string
	tenantApiKsa: string
	dataRegion: 'us' | 'ksa'
	iconBackground: string
	iconUrl: string | null
	appleTeamId: string | null
	androidSha256: string[]
	useTls: boolean
	site: { slug: string; host: string; origin: string }
	/** Hosts the white-label app claims as universal links (its own site only). */
	associatedDomains: string[]
}

/**
 * The same fields `tenants/<slug>.json` holds today, plus the data region and
 * the app-link claim. White-label apps claim only their own restaurant's
 * domain (#195); `associatedDomains` never lists another organization's host.
 */
export function buildCustomerAppConfig(
	app: BuildConfigApp,
	organization: BuildConfigOrganization,
	endpoints: TenantApiEndpoints,
): CustomerAppBuildConfig {
	const region: 'us' | 'ksa' = organization.dataRegion === 'ksa' ? 'ksa' : 'us'
	const useTls = !/^(localhost|127\.|10\.0\.2\.2|\[::1\])/.test(
		endpoints.appUrl,
	)
	return {
		slug: app.slug,
		displayName: app.displayName,
		bundleId: app.iosBundleId,
		androidPackage: app.androidPackage,
		marketingVersion: app.marketingVersion,
		appUrl: endpoints.appUrl,
		brandDomain: endpoints.brandDomain,
		tenantApiUs: region === 'us' ? endpoints.tenantApiUs : '',
		tenantApiKsa: region === 'ksa' ? endpoints.tenantApiKsa : '',
		dataRegion: region,
		iconBackground: app.iconBackground,
		iconUrl: organization.iconUrl,
		appleTeamId: app.appleTeamId,
		androidSha256: app.androidSha256,
		useTls,
		site: {
			slug: organization.slug,
			host: organization.siteHost,
			origin: organization.siteOrigin,
		},
		associatedDomains: organization.siteHost ? [organization.siteHost] : [],
	}
}

/** True when the organization moved regions after the last good build. */
export function rebuildRequired(input: {
	organizationRegion: string
	lastBuiltRegion: string | null
}): boolean {
	return (
		input.lastBuiltRegion !== null &&
		input.lastBuiltRegion !== input.organizationRegion
	)
}

// ---------------------------------------------------------------------------
// Builds and releases
// ---------------------------------------------------------------------------

export const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
export const releaseSchema = z.string().trim().regex(RELEASE_PATTERN)

export type BuildOutcome =
	| { appId: string; ok: true; buildIds: string[] }
	| { appId: string; ok: false; code: string; message: string }

/** What a bulk release reports back: per-app success or failure, retried one by one. */
export function summarizeRelease(outcomes: BuildOutcome[]) {
	const succeeded = outcomes.filter((o) => o.ok)
	const failed = outcomes.filter((o) => !o.ok)
	return {
		total: outcomes.length,
		succeeded: succeeded.length,
		failed: failed.length,
		failedAppIds: failed.map((o) => o.appId),
	}
}

// ---------------------------------------------------------------------------
// Account checks
// ---------------------------------------------------------------------------

export const ACCOUNT_CHECK_KINDS = [
	'developer_account',
	'store_terms',
	'payment_terms',
	'store_access',
] as const
export type AccountCheckKind = (typeof ACCOUNT_CHECK_KINDS)[number]

export const ACCOUNT_CHECK_STATUSES = ['pass', 'warn', 'fail'] as const
export type AccountCheckStatus = (typeof ACCOUNT_CHECK_STATUSES)[number]

/** What an adapter (or an Admin member) reports about the store account. */
export type AccountSnapshot = {
	developerAccountExpiresAt: number | null
	termsAccepted: boolean | null
	paymentTermsAccepted: boolean | null
	accessOk: boolean | null
}

/** Alerts go out this many days before a developer account expires (and on expiry). */
export const EXPIRY_ALERT_DAYS = [30, 7] as const
const DAY_MS = 24 * 60 * 60 * 1000

/** Step keys the UI maps to translated, step-by-step instructions. */
export type AccountCheckStepKey =
	| 'renew_developer_account'
	| 'pay_developer_fee'
	| 'accept_store_terms'
	| 'accept_payment_terms'
	| 'restore_store_access'

export type AccountCheckResult = {
	kind: AccountCheckKind
	status: AccountCheckStatus
	/** Whole days until the developer account expires; negative when expired. */
	daysLeft: number | null
	steps: AccountCheckStepKey[]
}

export function daysUntil(expiresAt: number, now: number): number {
	return Math.floor((expiresAt - now) / DAY_MS)
}

/** Pure: turns a snapshot into pass, warning or fail with the fix to follow. */
export function evaluateAccountChecks(
	snapshot: AccountSnapshot,
	now: number,
): AccountCheckResult[] {
	const results: AccountCheckResult[] = []
	if (snapshot.developerAccountExpiresAt !== null) {
		const daysLeft = daysUntil(snapshot.developerAccountExpiresAt, now)
		const status: AccountCheckStatus =
			daysLeft < 0 ? 'fail' : daysLeft <= EXPIRY_ALERT_DAYS[0] ? 'warn' : 'pass'
		results.push({
			kind: 'developer_account',
			status,
			daysLeft,
			steps:
				status === 'pass'
					? []
					: ['renew_developer_account', 'pay_developer_fee'],
		})
	}
	if (snapshot.termsAccepted !== null) {
		results.push({
			kind: 'store_terms',
			status: snapshot.termsAccepted ? 'pass' : 'fail',
			daysLeft: null,
			steps: snapshot.termsAccepted ? [] : ['accept_store_terms'],
		})
	}
	if (snapshot.paymentTermsAccepted !== null) {
		results.push({
			kind: 'payment_terms',
			status: snapshot.paymentTermsAccepted ? 'pass' : 'fail',
			daysLeft: null,
			steps: snapshot.paymentTermsAccepted ? [] : ['accept_payment_terms'],
		})
	}
	if (snapshot.accessOk !== null) {
		results.push({
			kind: 'store_access',
			status: snapshot.accessOk ? 'pass' : 'fail',
			daysLeft: null,
			steps: snapshot.accessOk ? [] : ['restore_store_access'],
		})
	}
	return results
}

/**
 * Which expiry alert is due, or null. `30` and `7` fire once each when the
 * threshold is crossed; `0` fires once on expiry. The caller dedupes with
 * `expiryAlertKey`, which changes when the expiry date does (a renewal re-arms
 * the alerts).
 */
export function dueExpiryAlert(
	expiresAt: number,
	now: number,
): 30 | 7 | 0 | null {
	const daysLeft = daysUntil(expiresAt, now)
	if (daysLeft < 0) return 0
	if (daysLeft <= EXPIRY_ALERT_DAYS[1]) return 7
	if (daysLeft <= EXPIRY_ALERT_DAYS[0]) return 30
	return null
}

export function expiryAlertKey(
	threshold: 30 | 7 | 0,
	expiresAt: number,
): string {
	return `developer_account:${threshold}:${new Date(expiresAt).toISOString().slice(0, 10)}`
}

/**
 * Restaurants whose app is published under Menuza's own account see store
 * health but not the account checks.
 */
export function showsAccountChecks(publisher: CustomerAppPublisher): boolean {
	return publisher === 'restaurant'
}

// ---------------------------------------------------------------------------
// Credentials (write-only)
// ---------------------------------------------------------------------------

const apnsUploadSchema = z.object({
	/** The `.p8` key file text. */
	key: z
		.string()
		.min(40)
		.max(4_000)
		.refine(
			(value) =>
				/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(
					value,
				),
			{
				error: 'This is not an APNs .p8 key',
			},
		),
	keyId: z
		.string()
		.regex(/^[A-Z0-9]{10}$/, { error: 'Key id is 10 characters' }),
	teamId: z
		.string()
		.regex(APPLE_TEAM_ID, { error: 'Team id is 10 characters' }),
})

const fcmUploadSchema = z.object({
	type: z.literal('service_account'),
	project_id: z.string().min(1).max(200),
	client_email: z.string().email().max(300),
	private_key: z.string().min(40).max(4_000),
})

export type CredentialParse =
	| {
			ok: true
			kind: CustomerAppCredentialKind
			secret: string
			teamId?: string
	  }
	| { ok: false; message: string }

/**
 * Checks an upload and returns the exact text to encrypt. Messages never echo
 * the secret. The caller encrypts `secret` and stores only the ciphertext.
 */
export function parseCredentialUpload(
	kind: CustomerAppCredentialKind,
	input: unknown,
): CredentialParse {
	if (kind === 'apns') {
		const parsed = apnsUploadSchema.safeParse(input)
		if (!parsed.success) {
			return {
				ok: false,
				message: parsed.error.issues[0]?.message ?? 'Invalid key',
			}
		}
		return {
			ok: true,
			kind,
			teamId: parsed.data.teamId,
			secret: JSON.stringify(parsed.data),
		}
	}
	let value = input
	if (typeof input === 'string') {
		try {
			value = JSON.parse(input)
		} catch {
			return {
				ok: false,
				message: 'This is not a Firebase service account file',
			}
		}
	}
	const parsed = fcmUploadSchema.safeParse(value)
	if (!parsed.success) {
		return {
			ok: false,
			message: 'This is not a Firebase service account file',
		}
	}
	const secret = JSON.stringify(value)
	if (secret.length > 8_000) {
		return { ok: false, message: 'The service account file is too large' }
	}
	return { ok: true, kind, secret }
}

/** What any API may say about a credential: set or not, and when. Never the value. */
export type CredentialStatus = {
	kind: CustomerAppCredentialKind
	set: boolean
	uploadedAt: string | null
}

export function credentialStatuses(
	rows: Array<{ kind: string; uploadedAt: Date | number }>,
): CredentialStatus[] {
	return CUSTOMER_APP_CREDENTIAL_KINDS.map((kind) => {
		const row = rows.find((candidate) => candidate.kind === kind)
		return {
			kind,
			set: Boolean(row),
			uploadedAt: row ? new Date(row.uploadedAt).toISOString() : null,
		}
	})
}

/** Push needs both: APNs for iOS builds, FCM for Android. */
export function pushCredentialsReady(statuses: CredentialStatus[]): {
	ios: boolean
	android: boolean
} {
	return {
		ios: statuses.find((s) => s.kind === 'apns')?.set ?? false,
		android: statuses.find((s) => s.kind === 'fcm')?.set ?? false,
	}
}
