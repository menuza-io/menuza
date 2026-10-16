import {
	ConfigFlag,
	db,
	eq,
	inArray,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import {
	PLATFORM_FEE_FLAG_KEY,
	RESERVATIONS_FLAG_KEYS,
	reservationsContextSchema,
} from '@repo/reservations'
import { ENV } from 'varlock/env'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader } from './reservations.context.ts'

const flagIds: string[] = []

afterEach(async () => {
	if (flagIds.length > 0) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds.splice(0)))
	}
})

describe('GET /resources/reservations/context (VAL-FND-018)', () => {
	it('returns 403 when unauthenticated, given a wrong bearer token, or given an operator session cookie without internal command token', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')

		const unauthRes = await loader({
			request: new Request(
				`http://localhost:3000/resources/reservations/context?orgId=${organization.id}`,
			),
			params: {},
			context: {},
		} as never)
		expect(unauthRes.status).toBe(403)

		const wrongTokenRes = await loader({
			request: new Request(
				`http://localhost:3000/resources/reservations/context?orgId=${organization.id}`,
				{ headers: { Authorization: 'Bearer wrong-token' } },
			),
			params: {},
			context: {},
		} as never)
		expect(wrongTokenRes.status).toBe(403)

		const sessionRes = await loader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/resources/reservations/context?orgId=${organization.id}`,
				{},
				cookie,
			),
			params: {},
			context: {},
		} as never)
		expect(sessionRes.status).toBe(403)
	})

	it('returns 400 on invalid orgId and 404 on unknown orgId', async () => {
		const badRes = await loader({
			request: new Request(
				'http://localhost:3000/resources/reservations/context?orgId=../bad',
				{ headers: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` } },
			),
			params: {},
			context: {},
		} as never)
		expect(badRes.status).toBe(400)

		const missingRes = await loader({
			request: new Request(
				'http://localhost:3000/resources/reservations/context?orgId=org_nonexistent_123',
				{ headers: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` } },
			),
			params: {},
			context: {},
		} as never)
		expect(missingRes.status).toBe(404)
	})

	it('returns folded flags, hex-converted emailTheme, locations, and payment readiness with zero PII', async () => {
		const { organization } = await setupTestOrgWithUser('admin')

		// Enable reservations.enabled and reservations.payments, set platform_fee_bp = 250
		const insertedFlags = await db
			.insert(ConfigFlag)
			.values([
				{
					key: RESERVATIONS_FLAG_KEYS.enabled,
					value: true,
					level: 'organization',
					organizationId: organization.id,
				},
				{
					key: RESERVATIONS_FLAG_KEYS.payments,
					value: true,
					level: 'organization',
					organizationId: organization.id,
				},
				{
					key: PLATFORM_FEE_FLAG_KEY,
					value: 250,
					level: 'system',
				},
			])
			.returning({ id: ConfigFlag.id })
		flagIds.push(...insertedFlags.map((f) => f.id))

		await db
			.update(Organization)
			.set({
				shopPaymentProvider: 'connect',
				stripeConnectAccountId: 'acct_test_123',
				stripeConnectChargesEnabled: true,
				sitePublished: true,
				siteTheme: JSON.stringify({
					palette: 'warm',
					mode: 'light',
				}),
			})
			.where(eq(Organization.id, organization.id))

		await db.insert(OrganizationLocation).values({
			organizationId: organization.id,
			name: 'SoHo',
			slug: 'soho',
			timezone: 'America/New_York',
			address: '100 Spring St, New York, NY',
			phone: '+12125550100',
			isDefault: true,
			isActive: true,
		})

		const res = await loader({
			request: new Request(
				`http://localhost:3000/resources/reservations/context?orgId=${organization.id}`,
				{ headers: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` } },
			),
			params: {},
			context: {},
		} as never)
		expect(res.status).toBe(200)
		const body = reservationsContextSchema.parse(await res.json())
		expect(body.orgId).toBe(organization.id)
		expect(body.dataRegion).toBe('us')
		expect(body.features).toEqual({
			enabled: true,
			online: false,
			waitlist: false,
			payments: true,
			experiences: false,
			voice: false,
		})
		expect(body.organization.sitePublished).toBe(true)
		expect(body.organization.emailTheme.primary).toMatch(/^#[0-9a-fA-F]{6}$/)
		expect(body.organization.emailTheme.background).toMatch(/^#[0-9a-fA-F]{6}$/)
		expect(body.locations).toHaveLength(1)
		expect(body.locations[0]?.slug).toBe('soho')
		expect(body.locations[0]?.timeZone).toBe('America/New_York')
		expect(body.locations[0]?.currency).toBe('USD')
		expect(body.locations[0]?.address?.formattedAddress).toBe(
			'100 Spring St, New York, NY',
		)
		expect(body.payments).toEqual({
			processor: 'connect',
			deposit: true,
			guarantee: true,
			platformFeeBp: 250,
		})
	})
})
