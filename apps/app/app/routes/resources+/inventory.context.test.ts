import { ConfigFlag, db, inArray } from '@repo/database'
import { INVENTORY_FLAG_KEYS, inventoryContextSchema } from '@repo/inventory'
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
import { loader } from './inventory.context.ts'

const OFF = {
	enabled: false,
	purchasing: false,
	recipes: false,
	prep: false,
	transfers: false,
}

const flagIds: string[] = []

async function setFlag(
	key: string,
	organizationId: string,
	value: unknown = true,
) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({ key, value, level: 'organization', organizationId })
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

function contextRequest(orgId: string, authenticated = true) {
	return new Request(
		`http://localhost:3000/resources/inventory/context?orgId=${orgId}`,
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

describe('GET /resources/inventory/context', () => {
	it('returns 401 when unauthenticated, given a wrong bearer token, or given an operator session cookie without the internal command token', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')

		const unauthRes = await callLoader(contextRequest(organization.id, false))
		expect(unauthRes.status).toBe(401)

		const wrongTokenRes = await callLoader(
			new Request(
				`http://localhost:3000/resources/inventory/context?orgId=${organization.id}`,
				{ headers: { Authorization: 'Bearer wrong-token' } },
			),
		)
		expect(wrongTokenRes.status).toBe(401)

		const sessionRes = await callLoader(
			createAuthenticatedRequest(
				`http://localhost:3000/resources/inventory/context?orgId=${organization.id}`,
				{},
				cookie,
			),
		)
		expect(sessionRes.status).toBe(401)
	})

	it('returns 400 on an invalid orgId and 404 on an unknown orgId', async () => {
		const badRes = await callLoader(contextRequest('../bad'))
		expect(badRes.status).toBe(400)

		const missingRes = await callLoader(contextRequest('org_nonexistent_123'))
		expect(missingRes.status).toBe(404)
	})

	it('returns all features off for an organization with no inventory flags', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const res = await callLoader(contextRequest(organization.id))
		expect(res.status).toBe(200)
		expect(res.headers.get('Cache-Control')).toBe('private, no-store')

		const body = inventoryContextSchema.parse(await res.json())
		expect(body).toEqual({ orgId: organization.id, features: OFF })
	})

	it('returns folded features for organization-level inventory flags', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(INVENTORY_FLAG_KEYS.enabled, organization.id)
		await setFlag(INVENTORY_FLAG_KEYS.purchasing, organization.id)
		await setFlag(INVENTORY_FLAG_KEYS.prep, organization.id)

		const res = await callLoader(contextRequest(organization.id))
		expect(res.status).toBe(200)

		const body = inventoryContextSchema.parse(await res.json())
		expect(body.orgId).toBe(organization.id)
		expect(body.features).toEqual({
			...OFF,
			enabled: true,
			purchasing: true,
			prep: true,
		})
	})

	it('folds child flags off while the master flag is off', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(INVENTORY_FLAG_KEYS.recipes, organization.id)
		await setFlag(INVENTORY_FLAG_KEYS.transfers, organization.id)

		const offRes = await callLoader(contextRequest(organization.id))
		const offBody = inventoryContextSchema.parse(await offRes.json())
		expect(offBody.features).toEqual(OFF)

		await setFlag(INVENTORY_FLAG_KEYS.enabled, organization.id)
		const onRes = await callLoader(contextRequest(organization.id))
		const onBody = inventoryContextSchema.parse(await onRes.json())
		expect(onBody.features).toEqual({
			...OFF,
			enabled: true,
			recipes: true,
			transfers: true,
		})
	})

	it('only a literal true turns a flag on', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(INVENTORY_FLAG_KEYS.enabled, organization.id, 'true')

		const res = await callLoader(contextRequest(organization.id))
		const body = inventoryContextSchema.parse(await res.json())
		expect(body.features).toEqual(OFF)
	})
})
