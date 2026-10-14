import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import {
	isStaffingReportSubject,
	STAFF_PAY_REPORT_PERMISSION,
} from './catalog-staffing.ts'
import { ENV } from './package-env.js'

export {
	isStaffingReportSubject,
	STAFF_PAY_REPORT_PERMISSION,
	STAFFING_REPORT_SUBJECTS,
	type StaffingReportSubject,
} from './catalog-staffing.ts'

export const OPERATOR_TOKEN_AUD = 'tenant-api-operator'
export const OPERATOR_TOKEN_ISS = 'menuza-control-plane'
export const OPERATOR_TOKEN_EXPIRY = '15m'
/** Tokens that unlock individual wages live shorter, like the staffing tokens. */
export const OPERATOR_PAY_TOKEN_EXPIRY = '5m'
const PAY_TOKEN_MAX_SECONDS = 5 * 60
const TOKEN_MAX_SECONDS = 15 * 60

export type OperatorAnalyticsRole = 'operator' | 'admin'

/**
 * Report subjects that need their own permission on top of analytics access,
 * because their rows hold data the analytics permissions don't cover (call
 * logs include caller phone numbers; orders are gated by menu access). The
 * token lists the ones granted.
 */
export const RESTRICTED_REPORT_SUBJECTS = [
	'phone_calls',
	'orders',
	'order_items',
	'order_options',
	'time_entries',
	'shifts',
	'labor_daily',
	'applications',
	'staff_pay',
] as const

/** Restricted subjects that menu access (which covers orders) grants. */
export const ORDER_REPORT_SUBJECTS = [
	'orders',
	'order_items',
	'order_options',
] as const satisfies readonly RestrictedReportSubject[]
export type RestrictedReportSubject =
	(typeof RESTRICTED_REPORT_SUBJECTS)[number]

function isRestrictedReportSubject(
	subject: string,
): subject is RestrictedReportSubject {
	return RESTRICTED_REPORT_SUBJECTS.some((restricted) => restricted === subject)
}

export type OperatorAnalyticsClaims = {
	userId: string
	orgId: string
	role: OperatorAnalyticsRole
	scope: 'analytics'
	subjects: RestrictedReportSubject[]
	/**
	 * Scopes the staff subjects are limited to: `null` for every scope,
	 * otherwise the list (empty means none). A token without the claim gets
	 * none, so it can never widen by omission.
	 */
	scopeIds: string[] | null
}

/** Whether a verified token may run reports on `subject`. */
export function operatorTokenAllowsSubject(
	claims: Pick<OperatorAnalyticsClaims, 'subjects'>,
	subject: string,
) {
	return (
		!isRestrictedReportSubject(subject) || claims.subjects.includes(subject)
	)
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
	/** Restricted subjects the user has the extra permission for. */
	subjects?: readonly RestrictedReportSubject[]
	/**
	 * The scopes staff subjects are limited to (`null` for all). Required
	 * whenever a staff subject or the pay permission is granted, so a caller
	 * can't forget to limit one.
	 */
	scopeIds?: readonly string[] | null
}): Promise<{ token: string; expiresAt: string }> {
	const key = signingKey(options.internalCommandToken)
	const subjects = [...new Set(options.subjects ?? [])]
	const staffGranted = subjects.some(
		(subject) =>
			isStaffingReportSubject(subject) ||
			subject === STAFF_PAY_REPORT_PERMISSION,
	)
	if (staffGranted && options.scopeIds === undefined) {
		throw new Error('Staff report subjects need a scope')
	}
	const pay = subjects.includes(STAFF_PAY_REPORT_PERMISSION)
	const expiresAt = new Date(
		Date.now() + (pay ? PAY_TOKEN_MAX_SECONDS : TOKEN_MAX_SECONDS) * 1000,
	)
	const token = await new SignJWT({
		orgId: options.orgId,
		role: options.role,
		scope: 'analytics',
		subjects,
		scopeIds: options.scopeIds ? [...new Set(options.scopeIds)] : null,
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(options.userId)
		.setIssuer(OPERATOR_TOKEN_ISS)
		.setAudience(OPERATOR_TOKEN_AUD)
		.setIssuedAt()
		.setExpirationTime(pay ? OPERATOR_PAY_TOKEN_EXPIRY : OPERATOR_TOKEN_EXPIRY)
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
		// Tokens without the claim grant no restricted subjects.
		const subjects = Array.isArray(payload.subjects)
			? payload.subjects.filter(
					(subject): subject is RestrictedReportSubject =>
						typeof subject === 'string' && isRestrictedReportSubject(subject),
				)
			: []
		// A token that grants wages must be a short-lived one, whatever its
		// signature says about its own lifetime, and must say how long it lives.
		const pay = subjects.includes(STAFF_PAY_REPORT_PERMISSION)
		const lifetime =
			typeof payload.exp === 'number' && typeof payload.iat === 'number'
				? payload.exp - payload.iat
				: null
		if (lifetime === null ? pay : !(lifetime > 0)) return null
		if (
			lifetime !== null &&
			lifetime > (pay ? PAY_TOKEN_MAX_SECONDS : TOKEN_MAX_SECONDS)
		) {
			return null
		}
		// `null` is every scope; anything unrecognized means none.
		const scopeIds =
			payload.scopeIds === null
				? null
				: Array.isArray(payload.scopeIds)
					? payload.scopeIds.filter(
							(id): id is string => typeof id === 'string' && id.length > 0,
						)
					: []
		return { userId, orgId, role, scope: 'analytics', subjects, scopeIds }
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
