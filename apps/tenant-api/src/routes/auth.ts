import crypto from 'node:crypto'
import { and, desc, eq, gt, gte, inArray, isNull } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { SignJWT, jwtVerify } from 'jose'
import { ENV } from 'varlock/env'
import { z } from 'zod'

import { brand } from '@repo/config/brand'
import { sendSms } from '@repo/sms'
import {
	customerRefreshTokens,
	customers,
	getTenantDb,
	TENANT_ORG_ID_PATTERN,
	runTenantTransaction,
} from '@repo/tenant-db'
import {
	lookupActiveOrganization,
	resolveOrganizationForBrowserAuth,
	resolvePublishedOrganization,
	type PublishedOrganization,
} from '../lib/origin.ts'
import {
	checkGlobalSendCap,
	rateLimit,
	rateLimitByKey,
} from '../lib/rate-limit.ts'
import { isValidPhone, legacyPhoneForms, normalizePhone } from '../lib/phone.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import { getBearerToken, hmacHash } from '../lib/secrets.ts'
import { evaluateAndSpawnTriggers } from '../services/journey-service.ts'
import { openPointsAccountOnSignIn } from '../services/loyalty-member-service.ts'
import { linkVerifiedCustomerToGuest } from '../services/rsv-customer-link.ts'

export const authRoutes = new Hono()

// Free-form but bounded: the digits-only shape is enforced after normalization
// so SMS cannot be pointed at arbitrary strings (SMS-pumping / injection).
const phoneInputSchema = z
	.string()
	.trim()
	.min(1, 'Phone number is required')
	.min(5, 'Invalid phone number')
	.max(32, 'Invalid phone number')

const sendCodeSchema = z.object({
	slug: z.string().max(253).optional(),
	host: z.string().max(253).optional(),
	phone: phoneInputSchema,
})

const verifyCodeSchema = z.object({
	slug: z.string().max(253).optional(),
	host: z.string().max(253).optional(),
	phone: phoneInputSchema,
	code: z.string().regex(/^\d{6}$/, 'Verification code must be 6 digits'),
})

const refreshSchema = z.object({
	refreshToken: z.string().min(1, 'refreshToken is required').max(256),
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN, 'Invalid orgId format'),
})

const logoutSchema = z.object({
	refreshToken: z.string().min(1).max(256).optional(),
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN).optional(),
})

const profileSchema = z.object({
	name: z
		.string()
		.trim()
		.min(2, 'Name is required')
		.max(100, 'Name is too long'),
	email: z
		.string()
		.max(254)
		.email('Invalid email address')
		.or(z.literal(''))
		.optional(),
})

const MIN_JWT_SECRET_LENGTH = 16

function getJwtSecret(): string {
	const secret = ENV.JWT_SECRET || ''
	// Never sign or verify with an empty/short key: HS256 over a blank secret is
	// forgeable by anyone.
	if (secret.length < MIN_JWT_SECRET_LENGTH) {
		throw new Error('JWT_SECRET is not configured')
	}
	return secret
}

const ACCESS_TOKEN_EXPIRY = '15m'
const REFRESH_TOKEN_EXPIRY_DAYS = 30
const REFRESH_TOKEN_EXPIRY_MS = REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000

/**
 * A refresh token presented again this soon after its rotation is a lost
 * answer (a timeout, a closed tab) or two tabs racing, not a stolen copy: it
 * gets a fresh pair in the same session instead of revoking every token.
 * Later than this it is treated as reuse.
 */
export const REFRESH_ROTATION_GRACE_MS = 60_000

/**
 * The customer-session contract clients rely on: only a 401, or a 403 with
 * this code, means the session is over. Every other answer is transient.
 */
const ORGANIZATION_INACTIVE = {
	error: 'Organization is no longer active',
	code: 'organization_inactive',
} as const
const ORGANIZATION_LOOKUP_UNAVAILABLE = {
	error: 'Service temporarily unavailable. Please try again.',
	code: 'temporarily_unavailable',
} as const
const LOOKUP_RETRY_AFTER_SECONDS = '30'

type CustomerOrganization =
	| {
			status: 'found'
			organization: {
				id: string
				slug: string
				customDomain: string | null
				dataRegion: string
			}
	  }
	| { status: 'inactive' }
	| { status: 'unavailable' }

/**
 * The organization a customer token belongs to. "We could not ask the control
 * plane" stays apart from "the organization is gone": only the second may end
 * a session, so an outage never signs every customer out.
 */
async function resolveCustomerOrganization(
	orgId: string,
	orgSlug?: string,
): Promise<CustomerOrganization> {
	const lookup = await lookupActiveOrganization(orgId)
	let organization = lookup.status === 'found' ? lookup.organization : null
	if (!organization && orgSlug) {
		const bySlug = await resolvePublishedOrganization({ slug: orgSlug })
		if (bySlug && bySlug.id === orgId) organization = bySlug
	}
	if (organization) {
		return orgMatchesNodeRegion(organization.dataRegion)
			? { status: 'found', organization }
			: { status: 'inactive' }
	}
	return lookup.status === 'unavailable'
		? { status: 'unavailable' }
		: { status: 'inactive' }
}

function organizationRefusal(c: Context, status: 'inactive' | 'unavailable') {
	if (status === 'unavailable') {
		return c.json(ORGANIZATION_LOOKUP_UNAVAILABLE, 503, {
			'Retry-After': LOOKUP_RETRY_AFTER_SECONDS,
		})
	}
	return c.json(ORGANIZATION_INACTIVE, 403)
}

function customerNeedsName(name: string | null | undefined) {
	return !name || name.trim().length < 2
}

type TenantDb = Awaited<ReturnType<typeof getTenantDb>>

function isSqliteBusyError(error: unknown) {
	return error instanceof Error && error.message.includes('SQLITE_BUSY')
}

async function retryOnSqliteBusy<T>(operation: () => Promise<T>): Promise<T> {
	let lastError: unknown
	for (const delayMs of [0, 10, 25, 50]) {
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs))
		}
		try {
			return await operation()
		} catch (error) {
			if (!isSqliteBusyError(error)) throw error
			lastError = error
		}
	}
	throw lastError
}

async function openTenantDb(orgId: string): Promise<TenantDb | null> {
	try {
		return await getTenantDb(orgId)
	} catch (error) {
		console.error('Tenant DB connection error:', error)
		return null
	}
}

async function loadProvisionedOrgDb(
	c: Context,
	body: { slug?: string; host?: string },
) {
	const organization = await resolveOrganizationForBrowserAuth(
		c.req.header('Origin'),
		body,
	)

	if (
		!organization ||
		!organization.hasProvisionedDb ||
		!orgMatchesNodeRegion(organization.dataRegion)
	) {
		return {
			error: c.json(
				{ error: 'Organization not found or DB not provisioned' },
				404,
			),
		}
	}

	const db = await openTenantDb(organization.id)
	if (!db) {
		return { error: c.json({ error: 'Tenant Database unavailable' }, 500) }
	}

	return { organization, db }
}

/**
 * The customer for an E.164 number. Rows written before phone normalization
 * may hold the number without `+` or in national form, so when no row has the
 * E.164 form the legacy forms are tried (exact match always wins). The row is
 * rewritten to E.164 after a successful verify (`upgradeLegacyPhone`).
 */
async function findCustomerByPhone(db: TenantDb, phone: string) {
	const exact = await db
		.select()
		.from(customers)
		.where(eq(customers.phone, phone))
		.get()
	if (exact) return exact
	const legacy = legacyPhoneForms(phone)
	if (legacy.length === 0) return undefined
	const rows = await db
		.select()
		.from(customers)
		.where(inArray(customers.phone, legacy)) // bounded: at most four forms
		.all()
	// Oldest row first: it is the original account, not a later duplicate.
	return rows.sort(
		(a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
	)[0]
}

/**
 * Moves a legacy-format row to E.164. A UNIQUE collision (another row already
 * holds the E.164 form) is left alone: the two rows are never merged here.
 */
async function upgradeLegacyPhone(
	db: TenantDb,
	customer: { id: string; phone: string | null },
	phone: string,
) {
	if (customer.phone === phone) return
	try {
		await db
			.update(customers)
			.set({ phone })
			.where(eq(customers.id, customer.id))
			.run()
	} catch (error) {
		console.warn(
			'Could not rewrite legacy phone to E.164 (kept as stored):',
			error instanceof Error ? error.message : 'unknown error',
		)
	}
}

async function issueSessionTokens(
	db: TenantDb,
	customer: { id: string; name: string },
	organization: PublishedOrganization,
	options: { revokeExisting?: boolean } = {},
) {
	const accessToken = await issueAccessToken({
		customerId: customer.id,
		orgId: organization.id,
		name: customer.name,
		orgSlug: organization.slug,
		customDomain: organization.customDomain,
	})
	const refreshToken = await issueRefreshToken(db, customer.id, {
		revokeExisting: options.revokeExisting,
	})
	return { accessToken, refreshToken }
}

/**
 * Issue a short-lived access token (15 minutes).
 */
async function issueAccessToken(payload: {
	customerId: string
	orgId: string
	name: string
	orgSlug: string
	customDomain?: string | null
}): Promise<string> {
	const secret = new TextEncoder().encode(getJwtSecret())
	return new SignJWT({
		...payload,
		type: 'access',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuer(brand.slug)
		.setAudience('tenant-api')
		.setExpirationTime(ACCESS_TOKEN_EXPIRY)
		.sign(secret)
}

/**
 * Generate a cryptographically random refresh token and store its HMAC hash in the DB.
 * Returns the raw token to the caller (browser JS on the tenant site).
 */
async function issueRefreshToken(
	db: Awaited<ReturnType<typeof getTenantDb>>,
	customerId: string,
	options: { revokeExisting?: boolean } = {},
): Promise<string> {
	const rawToken = crypto.randomBytes(32).toString('hex')
	const tokenHash = hmacHash(rawToken)
	const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS)
	const now = new Date()

	if (options.revokeExisting !== false) {
		await db
			.update(customerRefreshTokens)
			.set({ revokedAt: now })
			.where(
				and(
					eq(customerRefreshTokens.customerId, customerId),
					isNull(customerRefreshTokens.rotatedAt),
					isNull(customerRefreshTokens.revokedAt),
				),
			)
			.run()
	}

	await db.insert(customerRefreshTokens).values({
		customerId,
		tokenHash,
		expiresAt,
	})

	await db
		.update(customers)
		.set({
			refreshTokenHash: tokenHash,
			refreshTokenExpiresAt: expiresAt,
			updatedAt: new Date(),
		})
		.where(eq(customers.id, customerId))
		.run()

	return rawToken
}

async function revokeCustomerRefreshTokens(db: TenantDb, customerId: string) {
	const now = new Date()
	await Promise.all([
		db
			.update(customerRefreshTokens)
			.set({ revokedAt: now })
			.where(
				and(
					eq(customerRefreshTokens.customerId, customerId),
					isNull(customerRefreshTokens.revokedAt),
				),
			)
			.run(),
		db
			.update(customers)
			.set({
				refreshTokenHash: null,
				refreshTokenExpiresAt: null,
				updatedAt: now,
			})
			.where(eq(customers.id, customerId))
			.run(),
	])
}

/**
 * Authenticate a customer from a Bearer access token.
 */
export async function authenticateCustomer(c: Context) {
	const token = getBearerToken(c.req.header('Authorization')) || null

	if (!token) {
		throw c.json({ error: 'Unauthorized' }, 401)
	}
	let decoded: {
		customerId: string
		orgId: string
		orgSlug: string
		customDomain?: string | null
		type?: string
	}

	try {
		const secret = new TextEncoder().encode(getJwtSecret())
		const { payload } = await jwtVerify(token, secret, {
			issuer: brand.slug,
			audience: 'tenant-api',
			algorithms: ['HS256'],
		})
		decoded = payload as typeof decoded
	} catch {
		throw c.json({ error: 'Invalid or expired token' }, 401)
	}

	if (decoded.type !== 'access') {
		throw c.json({ error: 'Invalid token type. Please re-authenticate.' }, 401)
	}

	const { customerId, orgId } = decoded
	if (!customerId || !orgId) {
		throw c.json({ error: 'Invalid token payload' }, 401)
	}

	// Fail closed: a deactivated org, an org that moved regions, or an outage of
	// the control plane must never keep customer tokens alive from stale claims.
	// An outage answers 503 so clients keep the session and try again.
	const resolved = await resolveCustomerOrganization(
		orgId,
		typeof decoded.orgSlug === 'string' ? decoded.orgSlug : undefined,
	)
	if (resolved.status !== 'found') {
		throw organizationRefusal(c, resolved.status)
	}
	const { organization } = resolved

	const db = await openTenantDb(orgId)
	if (!db) {
		throw c.json({ error: 'Tenant Database unavailable' }, 500)
	}

	return { decoded, db, customerId, orgId, organization }
}

authRoutes.post(
	'/send-code',
	rateLimit('send-code', { maxRequests: 5, windowMs: 10 * 60 * 1000 }),
	async (c) => {
		const body = await c.req.json().catch(() => ({}))
		const parsed = sendCodeSchema.safeParse(body)

		if (!parsed.success) {
			return c.json(
				{ error: parsed.error.issues[0]?.message || 'Invalid payload' },
				400,
			)
		}

		let { phone } = parsed.data
		phone = normalizePhone(phone)
		if (!isValidPhone(phone)) {
			return c.json({ error: 'Invalid phone number' }, 400)
		}

		const loaded = await loadProvisionedOrgDb(c, parsed.data)
		if ('error' in loaded) return loaded.error
		const { db, organization } = loaded

		// Scoped per org so one tenant's customer cannot lock the same number
		// out of another tenant's sign-in.
		const phoneLimit = rateLimitByKey(
			'send-code-phone',
			JSON.stringify([organization.id, phone]),
			{
				maxRequests: 3,
				windowMs: 10 * 60 * 1000,
			},
		)
		if (phoneLimit.limited) {
			return c.json(
				{
					error: 'rate_limit_exceeded',
					error_description:
						'Too many verification attempts for this phone number.',
					retry_after: phoneLimit.retryAfter,
				},
				429,
			)
		}

		const globalLimit = checkGlobalSendCap()
		if (globalLimit.limited) {
			return c.json(
				{
					error: 'rate_limit_exceeded',
					error_description:
						'Service is temporarily unavailable. Please try again later.',
					retry_after: globalLimit.retryAfter,
				},
				429,
			)
		}

		const existing = await findCustomerByPhone(db, phone)

		const code = crypto.randomInt(100000, 1_000_000).toString()
		const hashedCode = hmacHash(code)
		const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

		if (existing) {
			await db
				.update(customers)
				.set({
					phoneVerificationCode: hashedCode,
					phoneVerificationExpiresAt: expiresAt,
				})
				.where(eq(customers.id, existing.id))
				.run()
		} else {
			await db
				.insert(customers)
				.values({
					name: '',
					phone,
					phoneVerificationCode: hashedCode,
					phoneVerificationExpiresAt: expiresAt,
				})
				.run()
		}

		try {
			await sendSms({
				to: phone,
				message: `Your verification code is: ${code}`,
			})
		} catch (error) {
			console.error('SMS sending error:', error)
			return c.json({ error: 'Failed to send SMS' }, 500)
		}

		return c.json({ success: true })
	},
)

authRoutes.post(
	'/verify',
	rateLimit('verify', { maxRequests: 5, windowMs: 60 * 1000 }),
	async (c) => {
		const body = await c.req.json().catch(() => ({}))
		const parsed = verifyCodeSchema.safeParse(body)

		if (!parsed.success) {
			return c.json(
				{ error: parsed.error.issues[0]?.message || 'Invalid payload' },
				400,
			)
		}

		let { phone, code } = parsed.data
		phone = normalizePhone(phone)
		if (!isValidPhone(phone)) {
			return c.json({ error: 'Invalid or expired code' }, 400)
		}

		const loaded = await loadProvisionedOrgDb(c, parsed.data)
		if ('error' in loaded) return loaded.error
		const { organization, db } = loaded

		const phoneLimit = rateLimitByKey(
			'verify-phone',
			JSON.stringify([organization.id, phone]),
			{
				maxRequests: 5,
				windowMs: 10 * 60 * 1000,
			},
		)
		if (phoneLimit.limited) {
			return c.json(
				{
					error: 'rate_limit_exceeded',
					error_description:
						'Too many verification attempts. Please request a new code.',
					retry_after: phoneLimit.retryAfter,
				},
				429,
			)
		}

		const customer = await findCustomerByPhone(db, phone)

		if (!customer) {
			return c.json({ error: 'Invalid or expired code' }, 400)
		}

		const hashedIncomingCode = hmacHash(code)

		if (
			!customer.phoneVerificationCode ||
			customer.phoneVerificationCode.length !== hashedIncomingCode.length ||
			!crypto.timingSafeEqual(
				Buffer.from(customer.phoneVerificationCode),
				Buffer.from(hashedIncomingCode),
			) ||
			!customer.phoneVerificationExpiresAt ||
			new Date() > customer.phoneVerificationExpiresAt
		) {
			return c.json({ error: 'Invalid or expired code' }, 400)
		}

		// Consume the code atomically so two concurrent requests presenting the
		// same OTP cannot both mint a session.
		const [consumed] = await db
			.update(customers)
			.set({
				phoneVerified: true,
				phoneVerificationCode: null,
				phoneVerificationExpiresAt: null,
			})
			.where(
				and(
					eq(customers.id, customer.id),
					eq(customers.phoneVerificationCode, customer.phoneVerificationCode),
				),
			)
			.returning({ id: customers.id })
		if (!consumed) {
			return c.json({ error: 'Invalid or expired code' }, 400)
		}

		await upgradeLegacyPhone(db, customer, phone)
		// The phone is now verified: link the reservation guest that carries it
		// (best effort, never fails sign-in, ids only).
		await linkVerifiedCustomerToGuest(db, customer.id, {
			orgId: organization.id,
		})

		const { accessToken, refreshToken } = await issueSessionTokens(
			db,
			customer,
			organization,
			{ revokeExisting: false },
		)

		// Fire-and-forget: evaluate active marketing journey triggers
		void evaluateAndSpawnTriggers(
			organization.id,
			'phone_verified',
			customer.id,
		).catch((err) => {
			console.error('Failed to evaluate phone_verified journey triggers:', err)
		})

		// Fire-and-forget: a verified customer is linked to the points system
		// without any step of their own (no terms, no enrollment). It never
		// delays or fails sign-in; the wallet and the first order cover a miss.
		void openPointsAccountOnSignIn(organization.id, customer.id)

		return c.json({
			success: true,
			accessToken,
			refreshToken,
			needsName: customerNeedsName(customer.name),
		})
	},
)

authRoutes.post(
	'/refresh',
	rateLimit('refresh', { maxRequests: 10, windowMs: 60 * 1000 }),
	async (c) => {
		const body = await c.req.json().catch(() => ({}))
		const parsed = refreshSchema.safeParse(body)

		if (!parsed.success) {
			return c.json({ error: 'Missing refreshToken or orgId' }, 400)
		}

		const { refreshToken, orgId } = parsed.data

		const resolved = await resolveCustomerOrganization(orgId)
		if (resolved.status !== 'found') {
			return organizationRefusal(c, resolved.status)
		}
		const { organization } = resolved

		const db = await openTenantDb(orgId)
		if (!db) {
			return c.json({ error: 'Tenant Database unavailable' }, 500)
		}

		const tokenHash = hmacHash(refreshToken)

		const newRefreshToken = crypto.randomBytes(32).toString('hex')
		const newRefreshTokenHash = hmacHash(newRefreshToken)
		const newRefreshTokenExpiresAt = new Date(
			Date.now() + REFRESH_TOKEN_EXPIRY_MS,
		)
		const rotation = await retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const revokeAll = async (customerId: string) => {
					const now = new Date()
					await tx
						.update(customerRefreshTokens)
						.set({ revokedAt: now })
						.where(
							and(
								eq(customerRefreshTokens.customerId, customerId),
								isNull(customerRefreshTokens.revokedAt),
							),
						)
						.run()
					await tx
						.update(customers)
						.set({
							refreshTokenHash: null,
							refreshTokenExpiresAt: null,
							updatedAt: now,
						})
						.where(eq(customers.id, customerId))
						.run()
				}

				const tokenRecord = await tx
					.select()
					.from(customerRefreshTokens)
					.where(eq(customerRefreshTokens.tokenHash, tokenHash))
					.get()

				if (tokenRecord) {
					const customer = await tx
						.select()
						.from(customers)
						.where(eq(customers.id, tokenRecord.customerId))
						.get()
					if (!customer) return { kind: 'invalid' as const, reason: 'invalid' }

					// Merely expired (never rotated or revoked) is not a replay: reject it
					// without signing the customer out of every other device.
					if (
						!tokenRecord.rotatedAt &&
						!tokenRecord.revokedAt &&
						new Date() > tokenRecord.expiresAt
					) {
						return { kind: 'invalid' as const, reason: 'expired' as const }
					}

					if (tokenRecord.rotatedAt && !tokenRecord.revokedAt) {
						const now = new Date()
						const sinceRotation =
							now.getTime() - tokenRecord.rotatedAt.getTime()
						if (
							sinceRotation >= 0 &&
							sinceRotation <= REFRESH_ROTATION_GRACE_MS
						) {
							// Rotate the session's live token (the successor the client
							// never received) so the session keeps exactly one.
							const successor = await tx
								.select({ id: customerRefreshTokens.id })
								.from(customerRefreshTokens)
								.where(
									and(
										eq(customerRefreshTokens.customerId, customer.id),
										isNull(customerRefreshTokens.rotatedAt),
										isNull(customerRefreshTokens.revokedAt),
										gt(customerRefreshTokens.expiresAt, now),
										gte(customerRefreshTokens.createdAt, tokenRecord.rotatedAt),
									),
								)
								.orderBy(desc(customerRefreshTokens.createdAt))
								.get()
							const [retired] = successor
								? await tx
										.update(customerRefreshTokens)
										.set({ rotatedAt: now })
										.where(
											and(
												eq(customerRefreshTokens.id, successor.id),
												isNull(customerRefreshTokens.rotatedAt),
												isNull(customerRefreshTokens.revokedAt),
											),
										)
										.returning({ id: customerRefreshTokens.id })
								: []
							if (retired) {
								await tx.insert(customerRefreshTokens).values({
									customerId: customer.id,
									tokenHash: newRefreshTokenHash,
									expiresAt: newRefreshTokenExpiresAt,
								})
								await tx
									.update(customers)
									.set({
										refreshTokenHash: newRefreshTokenHash,
										refreshTokenExpiresAt: newRefreshTokenExpiresAt,
										updatedAt: now,
									})
									.where(eq(customers.id, customer.id))
									.run()
								return { kind: 'rotated' as const, customer }
							}
						}
					}

					if (tokenRecord.rotatedAt || tokenRecord.revokedAt) {
						await revokeAll(customer.id)
						return {
							kind: 'invalid' as const,
							reason: 'reused' as const,
							customerId: customer.id,
						}
					}

					const [rotatedToken] = await tx
						.update(customerRefreshTokens)
						.set({ rotatedAt: new Date() })
						.where(
							and(
								eq(customerRefreshTokens.id, tokenRecord.id),
								isNull(customerRefreshTokens.rotatedAt),
								isNull(customerRefreshTokens.revokedAt),
							),
						)
						.returning({ id: customerRefreshTokens.id })
					if (!rotatedToken) {
						await revokeAll(customer.id)
						return {
							kind: 'invalid' as const,
							reason: 'reused' as const,
							customerId: customer.id,
						}
					}

					await tx.insert(customerRefreshTokens).values({
						customerId: customer.id,
						tokenHash: newRefreshTokenHash,
						expiresAt: newRefreshTokenExpiresAt,
					})
					await tx
						.update(customers)
						.set({
							refreshTokenHash: newRefreshTokenHash,
							refreshTokenExpiresAt: newRefreshTokenExpiresAt,
							updatedAt: new Date(),
						})
						.where(eq(customers.id, customer.id))
						.run()
					return { kind: 'rotated' as const, customer }
				}

				// Existing tenant databases may contain a legacy single refresh hash.
				// Accept it once, then move the session onto replay-detecting tokens.
				const customer = await tx
					.select()
					.from(customers)
					.where(eq(customers.refreshTokenHash, tokenHash))
					.get()
				if (!customer) return { kind: 'invalid' as const, reason: 'invalid' }
				if (
					!customer.refreshTokenExpiresAt ||
					new Date() > customer.refreshTokenExpiresAt
				) {
					await revokeAll(customer.id)
					return { kind: 'invalid' as const, reason: 'expired' as const }
				}

				const [migratedCustomer] = await tx
					.update(customers)
					.set({
						refreshTokenHash: newRefreshTokenHash,
						refreshTokenExpiresAt: newRefreshTokenExpiresAt,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(customers.id, customer.id),
							eq(customers.refreshTokenHash, tokenHash),
						),
					)
					.returning({ id: customers.id })
				if (!migratedCustomer) {
					await revokeAll(customer.id)
					return {
						kind: 'invalid' as const,
						reason: 'reused' as const,
						customerId: customer.id,
					}
				}
				await tx.insert(customerRefreshTokens).values({
					customerId: customer.id,
					tokenHash: newRefreshTokenHash,
					expiresAt: newRefreshTokenExpiresAt,
				})
				return { kind: 'rotated' as const, customer }
			}),
		)

		if (rotation.kind === 'invalid') {
			if (rotation.reason === 'reused') {
				console.warn('Refresh token reuse detected; revoked customer session', {
					customerId: rotation.customerId,
				})
			}
			return c.json(
				{
					error:
						rotation.reason === 'expired'
							? 'Refresh token expired. Please re-authenticate.'
							: 'Invalid refresh token',
				},
				401,
			)
		}

		const accessToken = await issueAccessToken({
			customerId: rotation.customer.id,
			orgId: organization.id,
			name: rotation.customer.name,
			orgSlug: organization.slug,
			customDomain: organization.customDomain,
		})

		return c.json({
			success: true,
			accessToken,
			refreshToken: newRefreshToken,
		})
	},
)

authRoutes.post(
	'/logout',
	rateLimit('logout', { maxRequests: 20, windowMs: 60 * 1000 }),
	async (c) => {
		const body = await c.req.json().catch(() => ({}))
		const parsed = logoutSchema.safeParse(body)

		if (parsed.success && parsed.data.refreshToken && parsed.data.orgId) {
			try {
				const db = await openTenantDb(parsed.data.orgId)
				if (!db) {
					return c.json({ success: true })
				}
				const tokenHash = hmacHash(parsed.data.refreshToken)

				const token = await db
					.select({
						id: customerRefreshTokens.id,
						customerId: customerRefreshTokens.customerId,
					})
					.from(customerRefreshTokens)
					.where(eq(customerRefreshTokens.tokenHash, tokenHash))
					.get()
				const now = new Date()
				if (token) {
					await db
						.update(customerRefreshTokens)
						.set({ revokedAt: now })
						.where(
							and(
								eq(customerRefreshTokens.id, token.id),
								isNull(customerRefreshTokens.revokedAt),
							),
						)
						.run()
					const successor = await db
						.select({
							tokenHash: customerRefreshTokens.tokenHash,
							expiresAt: customerRefreshTokens.expiresAt,
						})
						.from(customerRefreshTokens)
						.where(
							and(
								eq(customerRefreshTokens.customerId, token.customerId),
								isNull(customerRefreshTokens.rotatedAt),
								isNull(customerRefreshTokens.revokedAt),
								gt(customerRefreshTokens.expiresAt, now),
							),
						)
						.orderBy(desc(customerRefreshTokens.createdAt))
						.get()
					await db
						.update(customers)
						.set({
							refreshTokenHash: successor?.tokenHash ?? null,
							refreshTokenExpiresAt: successor?.expiresAt ?? null,
							updatedAt: now,
						})
						.where(eq(customers.id, token.customerId))
						.run()
				} else {
					const customer = await db
						.select({ id: customers.id })
						.from(customers)
						.where(eq(customers.refreshTokenHash, tokenHash))
						.get()
					if (customer) {
						await db
							.update(customers)
							.set({
								refreshTokenHash: null,
								refreshTokenExpiresAt: null,
								updatedAt: now,
							})
							.where(eq(customers.id, customer.id))
							.run()
					}
				}
			} catch (error) {
				console.error('Error invalidating refresh token:', error)
			}
		}

		return c.json({ success: true })
	},
)

authRoutes.post(
	'/profile',
	rateLimit('profile', { maxRequests: 20, windowMs: 60 * 1000 }),
	async (c) => {
		let auth
		try {
			auth = await authenticateCustomer(c)
		} catch (response) {
			return response as Response
		}

		const { db, customerId } = auth
		const body = await c.req.json().catch(() => ({}))
		const parsed = profileSchema.safeParse(body)

		if (!parsed.success) {
			return c.json(
				{ error: parsed.error.issues[0]?.message || 'Invalid payload' },
				400,
			)
		}

		const { name, email } = parsed.data

		try {
			const existing = await db
				.select()
				.from(customers)
				.where(eq(customers.id, customerId))
				.get()

			if (!existing) {
				return c.json({ error: 'Customer not found' }, 404)
			}

			await db
				.update(customers)
				.set({
					name,
					...(email !== undefined ? { email: email || null } : {}),
					updatedAt: new Date(),
				})
				.where(eq(customers.id, customerId))
				.run()

			// Re-issue only an access token (its `name` claim changed). Rotating the
			// refresh token here would sign the customer out of every other device.
			const accessToken = await issueAccessToken({
				customerId,
				orgId: auth.orgId,
				name,
				orgSlug: auth.organization.slug,
				customDomain: auth.organization.customDomain,
			})

			// Fire-and-forget: evaluate active marketing journey triggers
			void evaluateAndSpawnTriggers(
				auth.orgId,
				'profile_completed',
				customerId,
			).catch((err) => {
				console.error(
					'Failed to evaluate profile_completed journey triggers:',
					err,
				)
			})

			return c.json({ success: true, accessToken })
		} catch (error) {
			console.error('Error updating customer profile:', error)
			return c.json({ error: 'Internal Server Error' }, 500)
		}
	},
)

authRoutes.get('/me', async (c) => {
	let auth
	try {
		auth = await authenticateCustomer(c)
	} catch (response) {
		return response as Response
	}

	const { db, customerId } = auth

	const customer = await db
		.select()
		.from(customers)
		.where(eq(customers.id, customerId))
		.get()

	if (!customer) {
		return c.json({ error: 'Customer not found' }, 404)
	}

	return c.json({
		customer: {
			id: customer.id,
			name: customer.name,
			email: customer.email,
			phone: customer.phone,
			needsName: customerNeedsName(customer.name),
		},
	})
})
