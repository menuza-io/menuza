import { brand } from '@repo/config/brand'
import {
	DISCOUNT_READ_PERMISSION,
	DISCOUNT_TOKEN_AUDIENCE,
	DISCOUNT_TOKEN_TYP,
	discountTokenClaimsSchema,
} from '@repo/discounts'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { jwtVerify } from 'jose'
import { getNodeRegion } from './region.ts'
import { getBearerToken, getOperatorToken } from './secrets.ts'

export type DiscountOperatorContext = {
	orgId: string
	userId: string
	/** `null` = every location; `[]` = none. */
	locationIds: string[] | null
}

export type DiscountTokenVerificationResult =
	| { ok: true; context: DiscountOperatorContext }
	| { ok: false; status: 401 | 403 | 500; error: string }

/**
 * Verifies the short-lived `dsc+jwt` the App mints for usage counts.
 * Signed with `TENANT_OPERATOR_TOKEN`, audience
 * `tenant-api-discounts-operator`, and this node's region.
 */
export async function verifyDiscountOperatorToken(
	authHeader: string | undefined,
	options?: {
		secret?: string
		expectedRegion?: 'us' | 'ksa'
		clockToleranceSeconds?: number
	},
): Promise<DiscountTokenVerificationResult> {
	const operatorSecret = options?.secret ?? getOperatorToken()
	if (!operatorSecret || operatorSecret.length < 16) {
		return {
			ok: false,
			status: 500,
			error: 'Discount operator authentication is not configured',
		}
	}
	const token = getBearerToken(authHeader)
	if (!token) return { ok: false, status: 401, error: 'Missing bearer token' }

	let payload: unknown
	let protectedHeader: { typ?: string }
	try {
		const verified = await jwtVerify(
			token,
			new TextEncoder().encode(operatorSecret),
			{
				audience: DISCOUNT_TOKEN_AUDIENCE,
				issuer: brand.shortName,
				algorithms: ['HS256'],
				clockTolerance: options?.clockToleranceSeconds ?? 5,
			},
		)
		payload = verified.payload
		protectedHeader = verified.protectedHeader
	} catch {
		return {
			ok: false,
			status: 401,
			error: 'Invalid or expired discount operator token',
		}
	}
	if (protectedHeader.typ !== DISCOUNT_TOKEN_TYP) {
		return {
			ok: false,
			status: 401,
			error: 'Invalid discount operator token type',
		}
	}
	const parsed = discountTokenClaimsSchema.safeParse(payload)
	if (!parsed.success) {
		return {
			ok: false,
			status: 401,
			error: 'Malformed discount operator token claims',
		}
	}
	if (!TENANT_ORG_ID_PATTERN.test(parsed.data.orgId)) {
		return {
			ok: false,
			status: 401,
			error: 'Invalid organization in discount token',
		}
	}
	const expectedRegion = options?.expectedRegion ?? getNodeRegion()
	if (parsed.data.region !== expectedRegion) {
		return { ok: false, status: 403, error: 'region_mismatch' }
	}
	if (!parsed.data.grants.includes(DISCOUNT_READ_PERMISSION)) {
		return { ok: false, status: 403, error: 'Forbidden' }
	}
	return {
		ok: true,
		context: {
			orgId: parsed.data.orgId,
			userId: parsed.data.sub,
			locationIds: parsed.data.locationIds,
		},
	}
}
