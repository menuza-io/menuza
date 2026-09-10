import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { ENV } from './package-env.js'

export const OPERATOR_TOKEN_AUD = 'tenant-api-operator'
export const OPERATOR_TOKEN_ISS = 'epic-startup-control-plane'
export const OPERATOR_TOKEN_EXPIRY = '15m'

export type OperatorAnalyticsRole = 'operator' | 'admin'

export type OperatorAnalyticsClaims = {
	userId: string
	orgId: string
	role: OperatorAnalyticsRole
	scope: 'analytics'
}

function signingKey(internalCommandToken: string) {
	if (internalCommandToken.length < 16) {
		throw new Error('INTERNAL_COMMAND_TOKEN is not configured')
	}
	return createHash('sha256')
		.update('tenant-operator-analytics-v1:')
		.update(internalCommandToken)
		.digest()
}

export async function mintOperatorAnalyticsToken(options: {
	internalCommandToken: string
	userId: string
	orgId: string
	role: OperatorAnalyticsRole
}): Promise<{ token: string; expiresAt: string }> {
	const key = signingKey(options.internalCommandToken)
	const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
	const token = await new SignJWT({
		orgId: options.orgId,
		role: options.role,
		scope: 'analytics',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(options.userId)
		.setIssuer(OPERATOR_TOKEN_ISS)
		.setAudience(OPERATOR_TOKEN_AUD)
		.setIssuedAt()
		.setExpirationTime(OPERATOR_TOKEN_EXPIRY)
		.sign(key)

	return { token, expiresAt: expiresAt.toISOString() }
}

export async function verifyOperatorAnalyticsToken(options: {
	internalCommandToken: string
	token: string
}): Promise<OperatorAnalyticsClaims | null> {
	try {
		const { payload } = await jwtVerify(
			options.token,
			signingKey(options.internalCommandToken),
			{
				issuer: OPERATOR_TOKEN_ISS,
				audience: OPERATOR_TOKEN_AUD,
			},
		)
		const userId = typeof payload.sub === 'string' ? payload.sub : ''
		const orgId = typeof payload.orgId === 'string' ? payload.orgId : ''
		const role = payload.role === 'admin' ? 'admin' : 'operator'
		if (!userId || !orgId || payload.scope !== 'analytics') return null
		return { userId, orgId, role, scope: 'analytics' }
	} catch {
		return null
	}
}

export function resolvePublicTenantApiUrl(options: {
	dataRegion: string | null | undefined
	usUrl?: string | null
	ksaUrl?: string | null
	brandDomain?: string
	devPort?: string
}): string {
	const region =
		(options.dataRegion || 'us').toLowerCase() === 'ksa' ? 'ksa' : 'us'
	const configured = region === 'ksa' ? options.ksaUrl : options.usUrl
	if (configured) return configured.replace(/\/$/, '')
	if (options.brandDomain && ENV.NODE_ENV !== 'production') {
		const host =
			region === 'ksa'
				? `api-ksa.${options.brandDomain}`
				: `api.${options.brandDomain}`
		return `https://${host}:${options.devPort || '2999'}`
	}
	return region === 'ksa' ? 'http://localhost:3009' : 'http://localhost:3007'
}
