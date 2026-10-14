import {
	_OrganizationPermissionToRole,
	ConfigFlag,
	db,
	eq,
	inArray,
	Organization,
	OrganizationRole,
} from '@repo/database'
import {
	DEFAULT_SCOPE_ID,
	STAFFING_FLAG_KEYS,
	STAFFING_PERMISSIONS as P,
	type StaffingFeature,
} from '@repo/staffing'
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
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader as todayLoader } from './timeclock._index.tsx'
import {
	action as rulesAction,
	loader as rulesLoader,
} from './timeclock.rules.tsx'
import { loader as tabletsLoader } from './timeclock.tablets.tsx'
import { loader as layoutLoader } from './timeclock.tsx'

const flagIds: string[] = []

async function setFlag(feature: StaffingFeature, organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: STAFFING_FLAG_KEYS[feature],
			value: true,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

async function enableTimeclock(organizationId: string) {
	await setFlag('enabled', organizationId)
	await setFlag('timeclock', organizationId)
}

async function customRole(organizationId: string, permissions: string[]) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Custom ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	await db.insert(_OrganizationPermissionToRole).values(
		permissions.map((permission) => ({
			A: role!.id,
			B: `org_perm_${permission.replaceAll(':', '_')}`,
		})),
	)
	return role!.id
}

async function memberWith(organizationId: string, permissions: string[]) {
	const user = await createTestUser()
	await addOrganizationMember(
		user.id,
		organizationId,
		await customRole(organizationId, permissions),
	)
	const { cookie } = await createTestSession(user.id)
	return { user, cookie }
}

const loaders = {
	layout: layoutLoader,
	today: todayLoader,
	tablets: tabletsLoader,
	rules: rulesLoader,
} as const

async function run(
	name: keyof typeof loaders,
	slug: string,
	cookie: string,
): Promise<number | 'ok' | { redirect: string }> {
	try {
		await loaders[name]({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${slug}/staff/timeclock`,
				{},
				cookie,
			),
			params: { orgSlug: slug },
			context: {},
		} as never)
		return 'ok'
	} catch (error) {
		if (error instanceof Response) {
			if (error.status >= 300 && error.status < 400) {
				return { redirect: error.headers.get('Location') ?? '' }
			}
			return error.status
		}
		throw error
	}
}

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

describe('time clock route loaders', () => {
	it('are all 404 while staffing or the time clock flag is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		for (const name of Object.keys(loaders) as (keyof typeof loaders)[]) {
			expect(await run(name, organization.slug, cookie)).toBe(404)
		}
		// The master flag alone is not enough: the time clock has its own.
		await setFlag('enabled', organization.id)
		for (const name of Object.keys(loaders) as (keyof typeof loaders)[]) {
			expect(await run(name, organization.slug, cookie)).toBe(404)
		}
	})

	it('open for an admin once both flags are on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableTimeclock(organization.id)
		for (const name of Object.keys(loaders) as (keyof typeof loaders)[]) {
			expect(await run(name, organization.slug, cookie)).toBe('ok')
		}
	})

	it('returns 403 to a built-in member holding no staffing grants', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('member')
		await enableTimeclock(organization.id)
		for (const name of Object.keys(loaders) as (keyof typeof loaders)[]) {
			expect(await run(name, organization.slug, cookie)).toBe(403)
		}
	})

	it('splits the halves: timesheet readers get Today, policy readers get settings', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableTimeclock(organization.id)
		const reader = await memberWith(organization.id, [P.READ_TIMESHEET])
		expect(await run('today', organization.slug, reader.cookie)).toBe('ok')
		expect(await run('tablets', organization.slug, reader.cookie)).toBe(403)
		expect(await run('rules', organization.slug, reader.cookie)).toBe(403)

		const settings = await memberWith(organization.id, [P.READ_LABOR_POLICY])
		expect(await run('tablets', organization.slug, settings.cookie)).toBe('ok')
		expect(await run('rules', organization.slug, settings.cookie)).toBe('ok')
		// The front door sends them to the half they may open instead of a 403.
		expect(await run('today', organization.slug, settings.cookie)).toEqual({
			redirect: `/${organization.slug}/staff/timeclock/tablets`,
		})
	})

	it('does not open another organization to an admin of a different one', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		await enableTimeclock(b.organization.id)
		for (const name of Object.keys(loaders) as (keyof typeof loaders)[]) {
			expect(await run(name, b.organization.slug, a.cookie)).toBe(404)
		}
	})

	it('hands the Rules and Tablets screens only control-plane facts', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableTimeclock(organization.id)
		await db
			.update(Organization)
			.set({ staffingTimeZone: 'America/Chicago' })
			.where(eq(Organization.id, organization.id))
		const result = (await rulesLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/staff/timeclock/rules`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)) as unknown as {
			scopes: Array<Record<string, unknown>>
			canEditDefault: boolean
		}
		expect(result.canEditDefault).toBe(true)
		expect(result.scopes).toEqual([
			{
				id: DEFAULT_SCOPE_ID,
				name: organization.name,
				timeZone: 'America/Chicago',
			},
		])
	})
})

describe('staff time zone setting', () => {
	async function save(slug: string, cookie: string, timeZone: string) {
		try {
			const result = await rulesAction({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${slug}/staff/timeclock/rules`,
					{
						method: 'POST',
						body: new URLSearchParams({ timeZone }),
					},
					cookie,
				),
				params: { orgSlug: slug },
				context: {},
			} as never)
			return result as unknown as {
				data: unknown
				init: { status?: number } | null
			}
		} catch (error) {
			if (error instanceof Response) return error.status
			throw error
		}
	}

	async function storedZone(organizationId: string) {
		const [row] = await db
			.select({ zone: Organization.staffingTimeZone })
			.from(Organization)
			.where(eq(Organization.id, organizationId))
		return row!.zone
	}

	it('defaults to UTC and an admin can change it', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableTimeclock(organization.id)
		expect(await storedZone(organization.id)).toBe('UTC')
		const result = (await save(organization.slug, cookie, 'Asia/Riyadh')) as {
			data: unknown
		}
		expect(result.data).toEqual({ ok: true })
		expect(await storedZone(organization.id)).toBe('Asia/Riyadh')
	})

	it('refuses a zone that does not exist and changes nothing', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableTimeclock(organization.id)
		const result = (await save(organization.slug, cookie, 'Mars/Olympus')) as {
			init: { status?: number }
		}
		expect(result.init.status).toBe(400)
		expect(await storedZone(organization.id)).toBe('UTC')
	})

	it('is 404 while the time clock flag is off and 403 without the labor policy grant', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect(await save(organization.slug, cookie, 'Asia/Dubai')).toBe(404)
		await enableTimeclock(organization.id)
		const reader = await memberWith(organization.id, [
			P.READ_LABOR_POLICY,
			P.READ_STAFF,
		])
		expect(await save(organization.slug, reader.cookie, 'Asia/Dubai')).toBe(403)
		expect(await storedZone(organization.id)).toBe('UTC')
	})
})
