import { ConfigFlag, db, inArray } from '@repo/database'
import { LOYALTY_FLAG_KEYS, loyaltyContextSchema } from '@repo/loyalty'
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
import { loader } from './loyalty.context.ts'

const flagIds: string[] = []

async function setFlag(key: string, organizationId: string, value = true) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({ key, value, level: 'organization', organizationId })
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

function contextRequest(orgId: string, authenticated = true) {
	return new Request(
		`http://localhost:3000/resources/loyalty/context?orgId=${orgId}`,
		authenticated
			? { headers: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` } }
			: undefined,
	)
}

async function callLoader(request: Request) {
	return loader({ request, params: {}, context: {} } as never)
}

afterEach(async () => {
	if (flagIds.length > 0) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds.splice(0)))
	}
})

describe('GET /resources/loyalty/context', () => {
	it('returns 403 when unauthenticated, given a wrong bearer token, or given an operator session cookie without the internal command token', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')

		const unauthRes = await callLoader(contextRequest(organization.id, false))
		expect(unauthRes.status).toBe(403)

		const wrongTokenRes = await callLoader(
			new Request(
				`http://localhost:3000/resources/loyalty/context?orgId=${organization.id}`,
				{ headers: { Authorization: 'Bearer wrong-token' } },
			),
		)
		expect(wrongTokenRes.status).toBe(403)

		const sessionRes = await callLoader(
			createAuthenticatedRequest(
				`http://localhost:3000/resources/loyalty/context?orgId=${organization.id}`,
				{},
				cookie,
			),
		)
		expect(sessionRes.status).toBe(403)
	})

	it('returns 400 on an invalid orgId and 404 on an unknown orgId', async () => {
		const badRes = await callLoader(contextRequest('../bad'))
		expect(badRes.status).toBe(400)

		const missingRes = await callLoader(contextRequest('org_nonexistent_123'))
		expect(missingRes.status).toBe(404)
	})

	it('returns all features off for an organization with no loyalty flags', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const res = await callLoader(contextRequest(organization.id))
		expect(res.status).toBe(200)
		expect(res.headers.get('Cache-Control')).toBe('private, no-store')

		const body = loyaltyContextSchema.parse(await res.json())
		expect(body).toEqual({
			orgId: organization.id,
			features: { enabled: false, redemption: false },
		})
	})

	it('returns folded features for organization-level loyalty flags', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(LOYALTY_FLAG_KEYS.enabled, organization.id)
		await setFlag(LOYALTY_FLAG_KEYS.redemption, organization.id)

		const res = await callLoader(contextRequest(organization.id))
		expect(res.status).toBe(200)
		expect(res.headers.get('Cache-Control')).toBe('private, no-store')

		const body = loyaltyContextSchema.parse(await res.json())
		expect(body.orgId).toBe(organization.id)
		expect(body.features).toEqual({ enabled: true, redemption: true })
	})

	it('folds child flags off when the master flag is off (redemption requires enabled)', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		// Redemption on, master off: redemption folds to false.
		await setFlag(LOYALTY_FLAG_KEYS.redemption, organization.id)

		const offRes = await callLoader(contextRequest(organization.id))
		const offBody = loyaltyContextSchema.parse(await offRes.json())
		expect(offBody.features).toEqual({ enabled: false, redemption: false })

		// With the master on, redemption reads true.
		await setFlag(LOYALTY_FLAG_KEYS.enabled, organization.id)
		const onRes = await callLoader(contextRequest(organization.id))
		const onBody = loyaltyContextSchema.parse(await onRes.json())
		expect(onBody.features).toEqual({ enabled: true, redemption: true })
	})
})
