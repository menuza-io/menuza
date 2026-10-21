import {
	createHash,
	createHmac,
	hkdfSync,
	randomBytes,
	randomUUID,
} from 'node:crypto'
import {
	isTurnstileConfigured,
	parseTurnstileHostnames,
	verifyTurnstileToken,
} from '@repo/common/turnstile'
import {
	RESERVATIONS_TURNSTILE_ACTION,
	type ReservationsContext,
} from '@repo/reservations'
import { rsvRateCounters, type TenantDatabase } from '@repo/tenant-db'
import { and, eq, lt, sql } from 'drizzle-orm'
import { type Context } from 'hono'
import { ENV } from 'varlock/env'
import { type ZodTypeAny, type z } from 'zod'
import { HttpError, json, NO_STORE } from './http.ts'
import {
	type PublishedOrganization,
	resolveOrganizationForPublicOrigin,
} from './origin.ts'
import { orgMatchesNodeRegion } from './region.ts'
import { getReservationsContext } from './reservations-context.ts'
import {
	hmacHash,
	syncEnvFromProcess,
	timingSafeEqualString,
} from './secrets.ts'
import { resolveClientIp } from './rate-limit.ts'
import { retryOnSqliteBusy } from './sqlite-retry.ts'

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])

/** Kill switch for every `/reservations/*` route; operator routes never read it. */
export function isPublicReservationsDisabled(): boolean {
	syncEnvFromProcess()
	// The switch exists to be flipped without a deploy, and the varlock
	// snapshot never forgets a key that was later unset, so read the live
	// environment when there is one.
	const raw: unknown =
		typeof process !== 'undefined' && process.env
			? process.env.RESERVATIONS_PUBLIC_ENABLED
			: ENV.RESERVATIONS_PUBLIC_ENABLED
	if (raw === false) return true
	if (!raw) return false
	return DISABLED_VALUES.has(String(raw).trim().toLowerCase())
}

export function notFoundResponse(): Response {
	return json({ error: 'not_found' }, 404)
}

export function unavailableResponse(): Response {
	return json({ error: 'unavailable' }, 503)
}

export type PublicOrgScope = 'booking' | 'manage'

export type ResolvedPublicOrg = {
	org: PublishedOrganization
	context: ReservationsContext
}

/**
 * Organization, region and flag gate shared by every public route. The
 * organization comes from the browser `Origin` only. Everything that is not
 * "this organization exists here and has the feature on" answers the same
 * `404 not_found`, so a caller learns nothing about which organizations exist.
 * `booking` routes need `reservations.online`; `manage` routes (links already
 * in guests' hands) keep working when only the online child flag is off.
 */
export async function resolvePublicOrg(
	c: Context,
	scope: PublicOrgScope,
): Promise<
	{ ok: true; value: ResolvedPublicOrg } | { ok: false; response: Response }
> {
	if (isPublicReservationsDisabled()) {
		return { ok: false, response: unavailableResponse() }
	}

	const slug = c.req.query('slug')?.trim()
	const host = c.req.query('host')?.trim()
	const org = await resolveOrganizationForPublicOrigin(c.req.header('Origin'), {
		...(slug ? { slug } : {}),
		...(host ? { host } : {}),
	})
	if (!org || !org.hasProvisionedDb || !orgMatchesNodeRegion(org.dataRegion)) {
		return { ok: false, response: notFoundResponse() }
	}

	const context = await getReservationsContext(org.id)
	if (!context) return { ok: false, response: unavailableResponse() }
	if (context.dataRegion !== org.dataRegion || !context.features.enabled) {
		return { ok: false, response: notFoundResponse() }
	}
	if (scope === 'booking' && !context.features.online) {
		return { ok: false, response: notFoundResponse() }
	}
	return { ok: true, value: { org, context } }
}

// ---------------------------------------------------------------------------
// Validation: field paths only, never the submitted value
// ---------------------------------------------------------------------------

export function publicValidationResponse(error: z.ZodError): Response {
	return Response.json(
		{
			error: 'invalid',
			issues: error.issues.slice(0, 20).map((issue) => ({
				path: issue.path.join('.'),
				code: issue.code,
			})),
		},
		{ status: 400, headers: NO_STORE },
	)
}

export async function readPublicBody<S extends ZodTypeAny>(
	c: Context,
	schema: S,
): Promise<{ data: z.infer<S> } | { error: Response }> {
	let raw: unknown
	try {
		raw = await c.req.json()
	} catch {
		return {
			error: Response.json(
				{ error: 'invalid', issues: [{ path: '', code: 'invalid_json' }] },
				{ status: 400, headers: NO_STORE },
			),
		}
	}
	const parsed = schema.safeParse(raw)
	if (!parsed.success) {
		return { error: publicValidationResponse(parsed.error) }
	}
	return { data: parsed.data }
}

export function readPublicQuery<S extends ZodTypeAny>(
	c: Context,
	schema: S,
): { data: z.infer<S> } | { error: Response } {
	const raw = Object.fromEntries(new URL(c.req.url).searchParams)
	const parsed = schema.safeParse(raw)
	if (!parsed.success) return { error: publicValidationResponse(parsed.error) }
	return { data: parsed.data }
}

// ---------------------------------------------------------------------------
// Capability tokens
// ---------------------------------------------------------------------------

export const MANAGE_TOKEN_PREFIX = 'rsv_m_'
export const HOLD_TOKEN_PREFIX = 'rsv_h_'
const MAX_TOKEN_LENGTH = 256

let derivedKey: { secret: string; key: Buffer } | null = null

/** HKDF subkey of `AUTH_HMAC_SECRET`, so capability MACs never share a key with OTP or refresh hashes. */
function capabilityKey(): Buffer {
	syncEnvFromProcess()
	const secret = ENV.AUTH_HMAC_SECRET || ''
	if (secret.length < 16) {
		throw new Error('AUTH_HMAC_SECRET is not configured')
	}
	if (derivedKey?.secret !== secret) {
		derivedKey = {
			secret,
			key: Buffer.from(
				hkdfSync(
					'sha256',
					secret,
					'menuza-reservations',
					'capability-token-v1',
					32,
				),
			),
		}
	}
	return derivedKey.key
}

function b64url(input: Buffer | string): string {
	return Buffer.from(input).toString('base64url')
}

/**
 * Manage tokens are derived, never stored: `rsv_m_<id>.<mac>` where the MAC
 * binds purpose, organization, reservation and the rotation counter. Bumping
 * `manage_token_version` invalidates every outstanding link.
 */
export function deriveManageToken(
	orgId: string,
	reservationId: string,
	version: number,
): string {
	const mac = createHmac('sha256', capabilityKey())
		.update(`manage:${orgId}:${reservationId}:${version}`)
		.digest()
	return `${MANAGE_TOKEN_PREFIX}${b64url(reservationId)}.${b64url(mac)}`
}

export function parseManageTokenId(
	token: string | undefined | null,
): string | null {
	if (!token || token.length > MAX_TOKEN_LENGTH) return null
	if (!token.startsWith(MANAGE_TOKEN_PREFIX)) return null
	const body = token.slice(MANAGE_TOKEN_PREFIX.length)
	const dot = body.indexOf('.')
	if (dot <= 0 || dot === body.length - 1) return null
	const id = Buffer.from(body.slice(0, dot), 'base64url').toString('utf8')
	if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null
	return id
}

export function verifyManageToken(
	orgId: string,
	reservationId: string,
	version: number,
	presented: string,
): boolean {
	const expected = deriveManageToken(orgId, reservationId, version)
	return timingSafeEqualString(expected, presented)
}

export const WAITLIST_TOKEN_PREFIX = 'rsv_w_'
export const NOTIFY_TOKEN_PREFIX = 'rsv_n_'

function deriveBoundToken(
	prefix: string,
	purpose: string,
	orgId: string,
	id: string,
	version: number,
): string {
	const mac = createHmac('sha256', capabilityKey())
		.update(`${purpose}:${orgId}:${id}:${version}`)
		.digest()
	return `${prefix}${b64url(id)}.${b64url(mac)}`
}

function parseBoundTokenId(
	prefix: string,
	token: string | undefined | null,
): string | null {
	if (!token || token.length > MAX_TOKEN_LENGTH) return null
	if (!token.startsWith(prefix)) return null
	const body = token.slice(prefix.length)
	const dot = body.indexOf('.')
	if (dot <= 0 || dot === body.length - 1) return null
	const id = Buffer.from(body.slice(0, dot), 'base64url').toString('utf8')
	if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null
	return id
}

/** Waitlist status link token: derived from the entry id and `status_token_version`. */
export function deriveWaitlistToken(
	orgId: string,
	entryId: string,
	version: number,
): string {
	return deriveBoundToken(
		WAITLIST_TOKEN_PREFIX,
		'waitlist',
		orgId,
		entryId,
		version,
	)
}

export function parseWaitlistTokenId(
	token: string | undefined | null,
): string | null {
	return parseBoundTokenId(WAITLIST_TOKEN_PREFIX, token)
}

export function verifyWaitlistToken(
	orgId: string,
	entryId: string,
	version: number,
	presented: string,
): boolean {
	return timingSafeEqualString(
		deriveWaitlistToken(orgId, entryId, version),
		presented,
	)
}

/** Notify-me cancel token: derived from the request id and `token_version`. */
export function deriveNotifyToken(
	orgId: string,
	requestId: string,
	version: number,
): string {
	return deriveBoundToken(
		NOTIFY_TOKEN_PREFIX,
		'notify',
		orgId,
		requestId,
		version,
	)
}

export function parseNotifyTokenId(
	token: string | undefined | null,
): string | null {
	return parseBoundTokenId(NOTIFY_TOKEN_PREFIX, token)
}

export function verifyNotifyToken(
	orgId: string,
	requestId: string,
	version: number,
	presented: string,
): boolean {
	return timingSafeEqualString(
		deriveNotifyToken(orgId, requestId, version),
		presented,
	)
}

export const PAY_TOKEN_PREFIX = 'rsv_p_'
export const FEE_TOKEN_PREFIX = 'rsv_f_'

/** Payment-link token for a reservation: derived from the id and `manage_token_version`. */
export function deriveReservationPayToken(
	orgId: string,
	reservationId: string,
	version: number,
): string {
	return deriveBoundToken(
		PAY_TOKEN_PREFIX,
		'pay',
		orgId,
		reservationId,
		version,
	)
}

export function parseReservationPayTokenId(
	token: string | undefined | null,
): string | null {
	return parseBoundTokenId(PAY_TOKEN_PREFIX, token)
}

export function verifyReservationPayToken(
	orgId: string,
	reservationId: string,
	version: number,
	presented: string,
): boolean {
	return timingSafeEqualString(
		deriveReservationPayToken(orgId, reservationId, version),
		presented,
	)
}

/** Pay link for a fee the card on file could not cover: derived from the fee row id. */
export function deriveFeePayToken(orgId: string, feeId: string): string {
	return deriveBoundToken(FEE_TOKEN_PREFIX, 'feepay', orgId, feeId, 1)
}

export function parseFeePayTokenId(
	token: string | undefined | null,
): string | null {
	return parseBoundTokenId(FEE_TOKEN_PREFIX, token)
}

export function verifyFeePayToken(
	orgId: string,
	feeId: string,
	presented: string,
): boolean {
	return timingSafeEqualString(deriveFeePayToken(orgId, feeId), presented)
}

/**
 * Opaque guest reference for provider customers: an HMAC of the guest id, so
 * the App can key a PII-free Stripe Customer without ever seeing the id.
 */
export function deriveGuestRef(orgId: string, guestId: string): string {
	return b64url(
		createHmac('sha256', capabilityKey())
			.update(`guestref:${orgId}:${guestId}`)
			.digest(),
	)
}

export function newHoldToken(): string {
	return `${HOLD_TOKEN_PREFIX}${randomBytes(16).toString('base64url')}`
}

export function hashHoldToken(token: string): string {
	return createHash('sha256').update(token).digest('hex')
}

export function isWellFormedHoldToken(
	token: string | undefined | null,
): token is string {
	return (
		typeof token === 'string' &&
		token.length <= MAX_TOKEN_LENGTH &&
		/^rsv_h_[A-Za-z0-9_-]{16,64}$/.test(token)
	)
}

/** Token for a capability route: header first, then `?t=` where the caller allows it. */
export function readCapabilityToken(
	c: Context,
	options: { allowQuery?: boolean } = {},
): string | null {
	const header = c.req.header('X-Reservation-Token')?.trim()
	if (header) return header
	if (options.allowQuery) {
		const q = c.req.query('t')?.trim()
		if (q) return q
	}
	return null
}

export function randomFakeId(prefix: string): string {
	return `${prefix}_${randomUUID()}`
}

// ---------------------------------------------------------------------------
// Rate limits: in-memory per IP (always on, so dev and tests see 429s) and
// durable counters in `rsv_rate_counters` (survive restarts).
// ---------------------------------------------------------------------------

const memoryBuckets = new Map<string, number[]>()
const MEMORY_BUCKET_CAP = 20_000

export function resetPublicRateLimits() {
	memoryBuckets.clear()
}

export function clientIp(c: Context): string {
	return resolveClientIp(c)
}

export function clientIpHash(c: Context): string {
	try {
		return hmacHash(`rsv-ip:${resolveClientIp(c)}`)
	} catch {
		return 'unhashed'
	}
}

export function rateLimited(retryAfterSeconds: number): Response {
	return Response.json(
		{ error: 'rate_limited' },
		{
			status: 429,
			headers: {
				...NO_STORE,
				'Retry-After': String(Math.max(1, retryAfterSeconds)),
			},
		},
	)
}

/** Returns a 429 response when `name` is exhausted for this client IP, otherwise records the hit. */
export function enforceMemoryLimit(
	c: Context,
	name: string,
	max: number,
	windowMs: number,
	now = Date.now(),
): Response | null {
	const key = `${name}:${resolveClientIp(c)}`
	const recent = (memoryBuckets.get(key) ?? []).filter(
		(t) => t > now - windowMs,
	)
	if (recent.length >= max) {
		memoryBuckets.set(key, recent)
		return rateLimited(Math.ceil((recent[0]! + windowMs - now) / 1000))
	}
	recent.push(now)
	memoryBuckets.set(key, recent)
	if (memoryBuckets.size > MEMORY_BUCKET_CAP) {
		for (const [k, v] of memoryBuckets) {
			if (v.every((t) => t <= now - windowMs)) memoryBuckets.delete(k)
		}
		if (memoryBuckets.size > MEMORY_BUCKET_CAP) {
			memoryBuckets.delete(memoryBuckets.keys().next().value as string)
		}
	}
	return null
}

/**
 * Durable fixed-window counter. Counts the attempt first, then compares, so a
 * refusal itself is not free and a burst cannot slip past a concurrent read.
 */
export async function enforceDurableLimit(
	db: TenantDatabase,
	options: {
		bucket: string
		subjectHash: string
		max: number
		windowMs: number
		now?: number
	},
): Promise<Response | null> {
	const now = options.now ?? Date.now()
	const windowStart = Math.floor(now / options.windowMs) * options.windowMs
	const count = await retryOnSqliteBusy(async () => {
		await db
			.insert(rsvRateCounters)
			.values({
				bucket: options.bucket,
				subjectHash: options.subjectHash,
				windowStart,
				count: 1,
			})
			.onConflictDoUpdate({
				target: [
					rsvRateCounters.bucket,
					rsvRateCounters.subjectHash,
					rsvRateCounters.windowStart,
				],
				set: { count: sql`${rsvRateCounters.count} + 1` },
			})
		const row = await db
			.select({ count: rsvRateCounters.count })
			.from(rsvRateCounters)
			.where(
				and(
					eq(rsvRateCounters.bucket, options.bucket),
					eq(rsvRateCounters.subjectHash, options.subjectHash),
					eq(rsvRateCounters.windowStart, windowStart),
				),
			)
			.get()
		return row?.count ?? 0
	})
	if (count > options.max) {
		return rateLimited(Math.ceil((windowStart + options.windowMs - now) / 1000))
	}
	return null
}

/** Remove counter windows that can no longer matter (called opportunistically by writes). */
export async function purgeStaleRateCounters(
	db: TenantDatabase,
	now = Date.now(),
): Promise<void> {
	await db
		.delete(rsvRateCounters)
		.where(lt(rsvRateCounters.windowStart, now - 25 * 60 * 60 * 1000))
}

// ---------------------------------------------------------------------------
// Bot protection on public writes
// ---------------------------------------------------------------------------

/**
 * With `TURNSTILE_SECRET_KEY` configured a hold or request needs either a
 * valid customer access token for this organization (checked by the caller) or
 * a Turnstile token. Without the secret (local development) the challenge is
 * off.
 */
export async function verifyPublicChallenge(
	c: Context,
	token: unknown,
	options: { hasCustomer: boolean },
): Promise<boolean> {
	syncEnvFromProcess()
	const secret = ENV.TURNSTILE_SECRET_KEY ?? ''
	if (!isTurnstileConfigured(secret)) return true
	if (options.hasCustomer) return true
	const headerToken = c.req.header('X-Turnstile-Token')?.trim()
	const presented =
		typeof token === 'string' && token.trim() ? token : headerToken
	if (!presented) return false
	const ip = c.req.header('cf-connecting-ip')?.trim()
	const result = await verifyTurnstileToken({
		secret,
		token: presented,
		remoteIp: ip || undefined,
		expectedAction: RESERVATIONS_TURNSTILE_ACTION,
		expectedHostnames: parseTurnstileHostnames(ENV.TURNSTILE_HOSTNAMES),
	})
	return result.success
}

export function verificationFailedResponse(): Response {
	return json({ error: 'verification_failed' }, 403)
}

// ---------------------------------------------------------------------------
// Client channel
// ---------------------------------------------------------------------------

export type PublicClient = 'web' | 'ios' | 'android'

export function readClient(c: Context): {
	client: PublicClient
	channel: 'online' | 'native'
} {
	const raw = c.req.header('X-Client')?.trim().toLowerCase()
	if (raw === 'ios' || raw === 'android') {
		return { client: raw, channel: 'native' }
	}
	return { client: 'web', channel: 'online' }
}

export function readIdempotencyKey(c: Context): string | null {
	const key = c.req.header('Idempotency-Key')?.trim()
	if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return null
	return key
}

export function handlePublicError(error: unknown): Response {
	if (error instanceof Response) return error
	if (error instanceof HttpError) return error.toResponse()
	throw error
}
