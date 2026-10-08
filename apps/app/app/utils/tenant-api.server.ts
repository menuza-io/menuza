import { invariant } from '@epic-web/invariant'
import { requireUserId } from '@repo/auth'
import { brand } from '@repo/config/brand'
import { and, db, eq, Organization, UserOrganization } from '@repo/database'
import { SignJWT } from 'jose'
import { ENV } from 'varlock/env'
import { getBoundTenantApiService } from './tenant-api-service.server.ts'

export type TenantApiUrlEnv = {
	TENANT_API_URL?: string
	TENANT_API_URL_KSA?: string
}

export interface OperatorTenantClient {
	orgId: string
	orgSlug: string
	dataRegion: string
	jwt: string
	/** Server-to-server origin (may be http://localhost in local npm run dev). */
	tenantApiUrl: string
	/** Browser-facing origin. HTTPS via the dev proxy so App pages are not mixed content. */
	fetchTenant: (path: string, init?: RequestInit) => Promise<Response>
}

function stripTrailingSlash(value: string) {
	return value.replace(/\/$/, '')
}

function firstConfiguredUrl(
	...values: Array<string | undefined>
): string | undefined {
	for (const value of values) {
		if (value) return stripTrailingSlash(value)
	}
}

function envUrl(name: keyof TenantApiUrlEnv) {
	return ENV[name]
}

/**
 * Internal URL for App/Admin Node fetch, plus the public URL the browser must
 * use. Local `npm run dev` serves the App on HTTPS (`app.{brand}:2999`); the
 * browser cannot call `http://localhost:3007` (mixed content / private network).
 */
export function resolveRegionalTenantApiUrls(
	dataRegion: string,
	env: TenantApiUrlEnv = {
		TENANT_API_URL: envUrl('TENANT_API_URL'),
		TENANT_API_URL_KSA: envUrl('TENANT_API_URL_KSA'),
	},
) {
	const isKsa = dataRegion === 'ksa'
	const tenantApiUrl =
		firstConfiguredUrl(isKsa ? env.TENANT_API_URL_KSA : env.TENANT_API_URL) ||
		(isKsa ? 'http://localhost:3009' : 'http://localhost:3007')

	return { tenantApiUrl }
}

/**
 * Resolves operator authorization context and regional tenant-api client.
 */
export async function getOperatorTenantClient(
	request: Request,
	orgSlug: string,
	options: {
		scope?: 'mailbox' | 'phone_calls'
		/** Lets tenant-api accept changes (e.g. completing or tagging calls). */
		canUpdate?: boolean
		/** Lets tenant-api accept destructive calls (e.g. deleting call logs). */
		canDelete?: boolean
	} = {},
): Promise<OperatorTenantClient> {
	const userId = await requireUserId(request)
	invariant(orgSlug, 'orgSlug is required')

	const [organization] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			dataRegion: Organization.dataRegion,
		})
		.from(Organization)
		.innerJoin(
			UserOrganization,
			and(
				eq(UserOrganization.organizationId, Organization.id),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
		.where(and(eq(Organization.slug, orgSlug), eq(Organization.active, true)))

	if (!organization) {
		throw new Response('Organization not found or access denied', {
			status: 404,
		})
	}

	const operatorToken = ENV.TENANT_OPERATOR_TOKEN

	if (!operatorToken || operatorToken.length < 16) {
		throw new Response(
			'TENANT_OPERATOR_TOKEN must be configured with >= 16 chars',
			{
				status: 500,
			},
		)
	}

	const secret = new TextEncoder().encode(operatorToken)
	const jwt = await new SignJWT({
		orgId: organization.id,
		role: 'operator',
		scope: options.scope,
		...(options.canUpdate ? { canUpdate: true } : {}),
		...(options.canDelete ? { canDelete: true } : {}),
	})
		.setSubject(userId)
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(secret)

	const { tenantApiUrl } = resolveRegionalTenantApiUrls(organization.dataRegion)

	const fetchTenant = async (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers || {})
		headers.set('Authorization', `Bearer ${jwt}`)
		headers.set('Content-Type', 'application/json')

		const url = `${tenantApiUrl}${path.startsWith('/') ? path : `/${path}`}`
		const isUs = (organization.dataRegion || 'us').toLowerCase() !== 'ksa'
		const boundService = isUs ? getBoundTenantApiService() : null
		const fetchImpl = boundService
			? boundService.fetch.bind(boundService)
			: fetch

		return fetchImpl(url, {
			...init,
			headers,
		})
	}

	return {
		orgId: organization.id,
		orgSlug: organization.slug,
		dataRegion: organization.dataRegion,
		jwt,
		tenantApiUrl,
		fetchTenant,
	}
}

/**
 * Sends a platform phone-line ownership code. Always targets the US
 * tenant-api, the only node allowed to use Twilio.
 */
export class PhoneLineVerificationError extends Error {
	constructor(
		readonly status: number,
		readonly code: string | null,
	) {
		super(`Phone line verification failed with status ${status}`)
		this.name = 'PhoneLineVerificationError'
	}
}

export async function sendPhoneLineVerification(input: {
	/** tenant-api enforces its own per-org daily cap on verification sends. */
	orgId: string
	phone: string
	code: string
	method: 'sms' | 'call'
}): Promise<void> {
	const token = ENV.INTERNAL_COMMAND_TOKEN
	invariant(
		token && token.length >= 16,
		'INTERNAL_COMMAND_TOKEN must be configured with >= 16 chars',
	)
	const { tenantApiUrl } = resolveRegionalTenantApiUrls('us')
	const boundService = getBoundTenantApiService()
	const fetchImpl = boundService ? boundService.fetch.bind(boundService) : fetch
	const response = await fetchImpl(
		`${tenantApiUrl}/api/voice/line-verifications`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(15_000),
		},
	)
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			error?: unknown
		} | null
		throw new PhoneLineVerificationError(
			response.status,
			typeof body?.error === 'string' ? body.error : null,
		)
	}
}
