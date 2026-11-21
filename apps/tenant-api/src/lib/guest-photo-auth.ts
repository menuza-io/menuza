import { brand } from '@repo/config/brand'
import { and, ConfigFlag, db, eq, isNull, or } from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { jwtVerify } from 'jose'
import { LRUCache } from 'lru-cache'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import { fetchApp } from './app-service.ts'
import { getNodeRegion } from './region.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	getOperatorToken,
	syncEnvFromProcess,
} from './secrets.ts'

export const GUEST_PHOTO_TOKEN_AUDIENCE = 'tenant-api-guest-photos'
export const GUEST_PHOTO_TOKEN_TYP = 'pho+jwt'
export const GUEST_PHOTO_OPERATOR_PERMISSION = 'update:guest_photo:any'
export const GUEST_PHOTO_FLAG_KEY = 'menu.guest_photos'
export const GUEST_PHOTO_MAX_TTL_SECONDS = 900
export const GUEST_PHOTO_IMPERSONATED_MAX_TTL_SECONDS = 300

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])
const TRUE_VALUES = new Set(['true', '1', 'on', 'yes'])

const CONTEXT_FRESH_TTL_MS = 5 * 60 * 1000
const CONTEXT_FAILURE_COOLDOWN_MS = 30 * 1000
const CONTEXT_TIMEOUT_MS = 2_000

const flagCache = new LRUCache<string, { enabled: boolean; fetchedAt: number }>(
	{
		max: 500,
		ttl: CONTEXT_FRESH_TTL_MS,
	},
)
const lastFailureAt = new LRUCache<string, number>({
	max: 500,
	ttl: CONTEXT_FAILURE_COOLDOWN_MS,
})

function isFlagTrue(value: unknown): boolean {
	if (value === true) return true
	if (typeof value === 'string')
		return TRUE_VALUES.has(value.trim().toLowerCase())
	return false
}

/**
 * Regional kill switch (`GUEST_PHOTOS_ENABLED`, unset means on). Off stops all
 * guest photo uploads, submissions, and moderation endpoints with 503.
 */
export function isGuestPhotosKillSwitchOn(): boolean {
	syncEnvFromProcess()
	const raw: unknown =
		typeof process !== 'undefined' && process.env
			? process.env.GUEST_PHOTOS_ENABLED
			: (ENV as { GUEST_PHOTOS_ENABLED?: unknown }).GUEST_PHOTOS_ENABLED
	if (raw === false) return true
	if (!raw) return false
	return DISABLED_VALUES.has(String(raw).trim().toLowerCase())
}

export function seedGuestPhotosContextForTest(
	orgId: string,
	enabled: boolean,
	fetchedAt = Date.now(),
): void {
	flagCache.set(orgId, { enabled, fetchedAt })
	lastFailureAt.delete(orgId)
}

export function resetGuestPhotosContextForTests(): void {
	flagCache.clear()
	lastFailureAt.clear()
}

function resolveAppUrl(): string {
	syncEnvFromProcess()
	return (ENV.APP_URL || '').replace(/\/$/, '')
}

async function readFlagFromControlPlaneDb(orgId: string): Promise<boolean> {
	if (ENV.TENANT_API_RUNTIME === 'workers') return false
	try {
		const rows = await db
			.select({
				level: ConfigFlag.level,
				value: ConfigFlag.value,
			})
			.from(ConfigFlag)
			.where(
				and(
					eq(ConfigFlag.key, GUEST_PHOTO_FLAG_KEY),
					or(
						and(
							eq(ConfigFlag.level, 'organization'),
							eq(ConfigFlag.organizationId, orgId),
						),
						and(
							eq(ConfigFlag.level, 'system'),
							isNull(ConfigFlag.organizationId),
						),
					),
				),
			)
		const orgRow = rows.find((row) => row.level === 'organization')
		if (orgRow) return isFlagTrue(orgRow.value)
		const sysRow = rows.find((row) => row.level === 'system')
		return sysRow ? isFlagTrue(sysRow.value) : false
	} catch {
		return false
	}
}

const tenantOrgFlagSchema = z.object({
	id: z.string(),
	dataRegion: z.string().optional(),
	guestPhotosEnabled: z.boolean().optional(),
})

/**
 * Single regional check for whether guest dish photos may run for an org.
 * KSA organizations (and the KSA node) are always forced off.
 */
export async function isOrgGuestPhotosEnabled(
	orgId: string,
	dataRegion: string | null | undefined,
	options?: { now?: number },
): Promise<boolean> {
	if (isGuestPhotosKillSwitchOn()) return false
	if (getNodeRegion() === 'ksa') return false
	if ((dataRegion || '').toLowerCase() === 'ksa') return false
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) return false

	const now = options?.now ?? Date.now()
	const cached = flagCache.get(orgId)
	if (cached && now - cached.fetchedAt < CONTEXT_FRESH_TTL_MS) {
		return cached.enabled
	}

	const appUrl = resolveAppUrl()
	const token = getInternalCommandToken()
	if (appUrl && token.length >= 16) {
		const failedAt = lastFailureAt.get(orgId)
		if (
			failedAt !== undefined &&
			now - failedAt < CONTEXT_FAILURE_COOLDOWN_MS
		) {
			return false
		}
		try {
			const params = new URLSearchParams({ orgId })
			const response = await fetchApp(
				`${appUrl}/resources/tenant-organization?${params}`,
				{
					headers: {
						Accept: 'application/json',
						Authorization: `Bearer ${token}`,
					},
					signal: AbortSignal.timeout(CONTEXT_TIMEOUT_MS),
				},
			)
			if (response.ok) {
				const parsed = tenantOrgFlagSchema.safeParse(
					await response.json().catch(() => null),
				)
				if (parsed.success && parsed.data.id === orgId) {
					const enabled =
						(parsed.data.dataRegion || '').toLowerCase() !== 'ksa' &&
						parsed.data.guestPhotosEnabled === true
					flagCache.set(orgId, { enabled, fetchedAt: now })
					lastFailureAt.delete(orgId)
					return enabled
				}
			}
			lastFailureAt.set(orgId, now)
		} catch {
			lastFailureAt.set(orgId, now)
		}
	}

	const dbEnabled = await readFlagFromControlPlaneDb(orgId)
	flagCache.set(orgId, { enabled: dbEnabled, fetchedAt: now })
	return dbEnabled
}

export const guestPhotoTokenClaimsSchema = z
	.object({
		aud: z.literal(GUEST_PHOTO_TOKEN_AUDIENCE),
		role: z.literal('operator'),
		region: z.enum(['us', 'ksa']),
		orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
		sub: z.string().trim().min(1).max(128),
		grants: z.array(z.string().trim().min(1).max(64)).max(16),
		impersonated: z.boolean().default(false),
		iat: z.number().int().positive(),
		exp: z.number().int().positive(),
	})
	.passthrough()

export type GuestPhotoOperatorContext = {
	orgId: string
	userId: string
	region: 'us' | 'ksa'
	grants: readonly string[]
	impersonated: boolean
}

export type GuestPhotoTokenVerificationResult =
	| { ok: true; context: GuestPhotoOperatorContext }
	| {
			ok: false
			status: 401 | 403 | 500
			error: string
	  }

/**
 * Verifies a short-lived `pho+jwt` operator token minted by App
 * (`GET /<orgSlug>/menu/photos-token`).
 */
export async function verifyGuestPhotoOperatorToken(
	authHeader: string | undefined,
	options?: {
		secret?: string
		expectedRegion?: 'us' | 'ksa'
		clockToleranceSeconds?: number
	},
): Promise<GuestPhotoTokenVerificationResult> {
	const operatorSecret = options?.secret ?? getOperatorToken()
	if (!operatorSecret || operatorSecret.length < 16) {
		return {
			ok: false,
			status: 500,
			error: 'guest_photos_auth_not_configured',
		}
	}

	const token = getBearerToken(authHeader)
	if (!token) {
		return { ok: false, status: 401, error: 'missing_token' }
	}

	let payload: unknown
	let protectedHeader: { typ?: string }
	try {
		const verified = await jwtVerify(
			token,
			new TextEncoder().encode(operatorSecret),
			{
				audience: GUEST_PHOTO_TOKEN_AUDIENCE,
				issuer: brand.shortName,
				algorithms: ['HS256'],
				clockTolerance: options?.clockToleranceSeconds ?? 5,
			},
		)
		payload = verified.payload
		protectedHeader = verified.protectedHeader
	} catch {
		return { ok: false, status: 401, error: 'invalid_token' }
	}

	if (protectedHeader.typ !== GUEST_PHOTO_TOKEN_TYP) {
		return { ok: false, status: 401, error: 'invalid_token_type' }
	}

	const parsed = guestPhotoTokenClaimsSchema.safeParse(payload)
	if (!parsed.success) {
		return { ok: false, status: 401, error: 'invalid_claims' }
	}
	const claims = parsed.data

	const expectedRegion = options?.expectedRegion ?? getNodeRegion()
	if (claims.region !== expectedRegion) {
		return { ok: false, status: 403, error: 'region_mismatch' }
	}
	if (claims.region === 'ksa' || expectedRegion === 'ksa') {
		return { ok: false, status: 403, error: 'guest_photos_disabled' }
	}

	const lifetime = claims.exp - claims.iat
	const maxTtl = claims.impersonated
		? GUEST_PHOTO_IMPERSONATED_MAX_TTL_SECONDS
		: GUEST_PHOTO_MAX_TTL_SECONDS
	if (!(lifetime > 0) || lifetime > maxTtl) {
		return { ok: false, status: 401, error: 'token_ttl_exceeded' }
	}

	const effectiveGrants = claims.impersonated ? [] : claims.grants

	return {
		ok: true,
		context: {
			orgId: claims.orgId,
			userId: claims.sub,
			region: claims.region,
			grants: effectiveGrants,
			impersonated: claims.impersonated,
		},
	}
}
