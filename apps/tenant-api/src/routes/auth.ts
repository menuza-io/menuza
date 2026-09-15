import crypto from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
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
} from '@repo/tenant-db'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
	resolvePublishedOrganization,
	type PublishedOrganization,
} from '../lib/origin.ts'
import {
	checkGlobalSendCap,
	rateLimit,
	rateLimitByKey,
} from '../lib/rate-limit.ts'
import { orgMatchesNodeRegion, getNodeRegion } from '../lib/region.ts'
import { getBearerToken, hmacHash } from '../lib/secrets.ts'
import { evaluateAndSpawnTriggers } from '../services/journey-service.ts'

export const authRoutes = new Hono()

const sendCodeSchema = z.object({
	slug: z.string().optional(),
	host: z.string().optional(),
	phone: z.string().min(5, 'Phone number is required'),
})

const verifyCodeSchema = z.object({
	slug: z.string().optional(),
	host: z.string().optional(),
	phone: z.string().min(5, 'Phone number is required'),
	code: z.string().length(6, 'Verification code must be 6 digits'),
})

const refreshSchema = z.object({
	refreshToken: z.string().min(1, 'refreshToken is required'),
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN, 'Invalid orgId format'),
})

const logoutSchema = z.object({
	refreshToken: z.string().min(1).optional(),
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN).optional(),
})

const profileSchema = z.object({
	name: z.string().min(2, 'Name is required'),
	email: z.string().email('Invalid email address').or(z.literal('')).optional(),
})

function getJwtSecret(): string {
	return ENV.JWT_SECRET || ''
}

const ACCESS_TOKEN_EXPIRY = '15m'
const REFRESH_TOKEN_EXPIRY_DAYS = 30
const REFRESH_TOKEN_EXPIRY_MS = REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000

function normalizePhone(phone: string) {
	return phone.replace(/[\s\-()]/g, '')
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

async function issueSessionTokens(
	db: TenantDb,
	customer: { id: string; name: string },
	organization: PublishedOrganization,
) {
	const accessToken = await issueAccessToken({
		customerId: customer.id,
		orgId: organization.id,
		name: customer.name,
		orgSlug: organization.slug,
		customDomain: organization.customDomain,
	})
	const refreshToken = await issueRefreshToken(db, customer.id)
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

	let organization = await findActiveOrganizationById(orgId)
	if (!organization && typeof decoded.orgSlug === 'string' && decoded.orgSlug) {
		organization = await resolvePublishedOrganization({ slug: decoded.orgSlug })
		if (organization && organization.id !== orgId) {
			organization = null
		}
	}

	if (!organization || !orgMatchesNodeRegion(organization.dataRegion)) {
		const db = await openTenantDb(orgId)
		if (db && typeof decoded.orgSlug === 'string' && decoded.orgSlug) {
			return {
				decoded,
				db,
				customerId,
				orgId,
				organization: {
					id: orgId,
					slug: decoded.orgSlug,
					customDomain: decoded.customDomain ?? null,
					hasProvisionedDb: true,
					dataRegion: getNodeRegion(),
				},
			}
		}
		throw c.json({ error: 'Organization is no longer active' }, 403)
	}

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
				{ error: parsed.error.errors[0]?.message || 'Invalid payload' },
				400,
			)
		}

		let { phone } = parsed.data
		phone = normalizePhone(phone)
		if (!phone) {
			return c.json({ error: 'Invalid phone number' }, 400)
		}

		const loaded = await loadProvisionedOrgDb(c, parsed.data)
		if ('error' in loaded) return loaded.error
		const { db } = loaded

		const phoneLimit = rateLimitByKey('send-code-phone', phone, {
			maxRequests: 3,
			windowMs: 10 * 60 * 1000,
		})
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

		const existing = await db
			.select()
			.from(customers)
			.where(eq(customers.phone, phone))
			.get()

		const code = crypto.randomInt(100000, 999999).toString()
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
				{ error: parsed.error.errors[0]?.message || 'Invalid payload' },
				400,
			)
		}

		let { phone, code } = parsed.data
		phone = normalizePhone(phone)

		const loaded = await loadProvisionedOrgDb(c, parsed.data)
		if ('error' in loaded) return loaded.error
		const { organization, db } = loaded

		const phoneLimit = rateLimitByKey('verify-phone', phone, {
			maxRequests: 5,
			windowMs: 10 * 60 * 1000,
		})
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

		const customer = await db
			.select()
			.from(customers)
			.where(eq(customers.phone, phone))
			.get()

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

		await db
			.update(customers)
			.set({
				phoneVerified: true,
				phoneVerificationCode: null,
				phoneVerificationExpiresAt: null,
			})
			.where(eq(customers.id, customer.id))
			.run()

		const { accessToken, refreshToken } = await issueSessionTokens(
			db,
			customer,
			organization,
		)

		// Fire-and-forget: evaluate active marketing journey triggers
		void evaluateAndSpawnTriggers(
			organization.id,
			'phone_verified',
			customer.id,
		).catch((err) => {
			console.error('Failed to evaluate phone_verified journey triggers:', err)
		})

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

		const organization = await findActiveOrganizationById(orgId)

		if (!organization || !orgMatchesNodeRegion(organization.dataRegion)) {
			return c.json({ error: 'Organization is no longer active' }, 403)
		}

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
			db.transaction(async (tx) => {
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

					if (
						tokenRecord.rotatedAt ||
						tokenRecord.revokedAt ||
						new Date() > tokenRecord.expiresAt
					) {
						await revokeAll(customer.id)
						return {
							kind: 'invalid' as const,
							reason: tokenRecord.expiresAt < new Date() ? 'expired' : 'reused',
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

authRoutes.post('/logout', async (c) => {
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
				.select({ customerId: customerRefreshTokens.customerId })
				.from(customerRefreshTokens)
				.where(eq(customerRefreshTokens.tokenHash, tokenHash))
				.get()
			if (token) {
				await revokeCustomerRefreshTokens(db, token.customerId)
			} else {
				const customer = await db
					.select({ id: customers.id })
					.from(customers)
					.where(eq(customers.refreshTokenHash, tokenHash))
					.get()
				if (customer) await revokeCustomerRefreshTokens(db, customer.id)
			}
		} catch (error) {
			console.error('Error invalidating refresh token:', error)
		}
	}

	return c.json({ success: true })
})

authRoutes.post('/profile', async (c) => {
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
			{ error: parsed.error.errors[0]?.message || 'Invalid payload' },
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

		const { accessToken, refreshToken } = await issueSessionTokens(
			db,
			{ id: customerId, name },
			auth.organization,
		)

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

		return c.json({ success: true, accessToken, refreshToken })
	} catch (error) {
		console.error('Error updating customer profile:', error)
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

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
