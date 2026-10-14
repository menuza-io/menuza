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
import { loader as cardLoader } from './timeclock.timesheets.$entryId.tsx'
import { loader as newLoader } from './timeclock.timesheets.new.tsx'
import { loader as listLoader } from './timeclock.timesheets.tsx'
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

async function memberWith(organizationId: string, permissions: string[]) {
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
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, role!.id)
	const { cookie } = await createTestSession(user.id)
	return { user, cookie }
}

const loaders = {
	list: listLoader,
	card: cardLoader,
	new: newLoader,
} as const

async function call(
	name: keyof typeof loaders,
	slug: string,
	cookie: string,
): Promise<number | { data: unknown }> {
	try {
		const data = await loaders[name]({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${slug}/staff/timeclock/timesheets`,
				{},
				cookie,
			),
			params: { orgSlug: slug, entryId: 'entry-1' },
			context: {},
		} as never)
		return { data }
	} catch (error) {
		if (error instanceof Response) return error.status
		throw error
	}
}

const status = async (...args: Parameters<typeof call>) => {
	const result = await call(...args)
	return typeof result === 'number' ? result : 'ok'
}

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

describe('timesheet route loaders', () => {
	it('are 404 while staffing or the time clock flag is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		for (const name of Object.keys(loaders) as (keyof typeof loaders)[]) {
			expect(await status(name, organization.slug, cookie)).toBe(404)
		}
		await setFlag('enabled', organization.id)
		for (const name of Object.keys(loaders) as (keyof typeof loaders)[]) {
			expect(await status(name, organization.slug, cookie)).toBe(404)
		}
	})

	it('open for an admin once both flags are on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableTimeclock(organization.id)
		for (const name of Object.keys(loaders) as (keyof typeof loaders)[]) {
			expect(await status(name, organization.slug, cookie)).toBe('ok')
		}
	})

	it('are 403 for a member holding no staffing grants', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('member')
		await enableTimeclock(organization.id)
		for (const name of Object.keys(loaders) as (keyof typeof loaders)[]) {
			expect(await status(name, organization.slug, cookie)).toBe(403)
		}
	})

	it('need the roster grant too, because names come from the roster', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableTimeclock(organization.id)
		const onlyTimesheets = await memberWith(organization.id, [P.READ_TIMESHEET])
		for (const name of Object.keys(loaders) as (keyof typeof loaders)[]) {
			expect(await status(name, organization.slug, onlyTimesheets.cookie)).toBe(
				403,
			)
		}
		const onlyRoster = await memberWith(organization.id, [P.READ_STAFF])
		expect(await status('list', organization.slug, onlyRoster.cookie)).toBe(403)
	})

	it('a reader can look at the list and a card but not add one', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableTimeclock(organization.id)
		const reader = await memberWith(organization.id, [
			P.READ_TIMESHEET,
			P.READ_STAFF,
		])
		expect(await status('list', organization.slug, reader.cookie)).toBe('ok')
		expect(await status('card', organization.slug, reader.cookie)).toBe('ok')
		expect(await status('new', organization.slug, reader.cookie)).toBe(403)

		const editor = await memberWith(organization.id, [
			P.UPDATE_TIMESHEET,
			P.READ_STAFF,
		])
		// `update` implies `read`.
		expect(await status('list', organization.slug, editor.cookie)).toBe('ok')
		expect(await status('new', organization.slug, editor.cookie)).toBe('ok')
	})

	it('do not open another organization to an admin of a different one', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		await enableTimeclock(b.organization.id)
		for (const name of Object.keys(loaders) as (keyof typeof loaders)[]) {
			expect(await status(name, b.organization.slug, a.cookie)).toBe(404)
		}
	})

	it('hand the screen only the one implicit workplace name and time zone, never staff', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableTimeclock(organization.id)
		await db
			.update(Organization)
			.set({ staffingTimeZone: 'America/Chicago' })
			.where(eq(Organization.id, organization.id))
		const result = (await call('list', organization.slug, cookie)) as {
			data: { scopes: unknown[]; canChangePayPeriod: boolean }
		}
		expect(result.data.scopes).toEqual([
			{
				id: DEFAULT_SCOPE_ID,
				name: organization.name,
				timeZone: 'America/Chicago',
			},
		])
		expect(result.data.canChangePayPeriod).toBe(true)
		expect(Object.keys(result.data).sort()).toEqual([
			'canChangePayPeriod',
			'orgSlug',
			'scopes',
		])
	})

	it('only offer the pay period to someone who may change labor rules', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableTimeclock(organization.id)
		const reader = await memberWith(organization.id, [
			P.READ_TIMESHEET,
			P.READ_STAFF,
		])
		const result = (await call('list', organization.slug, reader.cookie)) as {
			data: { canChangePayPeriod: boolean }
		}
		expect(result.data.canChangePayPeriod).toBe(false)
	})
})

describe('time clock layout tabs', () => {
	async function tabs(slug: string, cookie: string) {
		return (await layoutLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${slug}/staff/timeclock`,
				{},
				cookie,
			),
			params: { orgSlug: slug },
			context: {},
		} as never)) as unknown as { canTimesheets: boolean; canToday: boolean }
	}

	it('offers Timesheets only with both read grants', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableTimeclock(organization.id)
		const both = await memberWith(organization.id, [
			P.READ_TIMESHEET,
			P.READ_STAFF,
		])
		expect((await tabs(organization.slug, both.cookie)).canTimesheets).toBe(
			true,
		)
		const only = await memberWith(organization.id, [P.READ_TIMESHEET])
		const result = await tabs(organization.slug, only.cookie)
		expect(result.canToday).toBe(true)
		expect(result.canTimesheets).toBe(false)
	})
})
