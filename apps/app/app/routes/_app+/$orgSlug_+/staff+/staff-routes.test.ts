import { ConfigFlag, db, inArray } from '@repo/database'
import { STAFFING_FLAG_KEYS, type StaffingFeature } from '@repo/staffing'
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
import { loader as indexLoader } from './_index.tsx'
import { loader as layoutLoader } from './_layout.tsx'
import { loader as hiringLoader } from './hiring.tsx'
import { loader as scheduleLoader } from './schedule.tsx'
import { loader as teamLoader } from './team.tsx'
import { loader as timeclockLoader } from './timeclock.tsx'

const flagIds: string[] = []

async function setFlag(
	feature: StaffingFeature,
	organizationId: string,
	value: unknown = true,
) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: STAFFING_FLAG_KEYS[feature],
			value,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

const loaders = {
	index: indexLoader,
	layout: layoutLoader,
	team: teamLoader,
	timeclock: timeclockLoader,
	schedule: scheduleLoader,
	hiring: hiringLoader,
} as const

async function run(
	name: keyof typeof loaders,
	slug: string,
	cookie: string,
): Promise<number | 'ok'> {
	try {
		await loaders[name]({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${slug}/staff/${name}`,
				{},
				cookie,
			),
			params: { orgSlug: slug },
			context: {},
		} as any)
		return 'ok'
	} catch (error) {
		if (error instanceof Response) return error.status
		throw error
	}
}

async function runAll(slug: string, cookie: string) {
	const entries = await Promise.all(
		(Object.keys(loaders) as (keyof typeof loaders)[]).map(
			async (name) => [name, await run(name, slug, cookie)] as const,
		),
	)
	return Object.fromEntries(entries)
}

const ALL = (status: number | 'ok') => ({
	index: status,
	layout: status,
	team: status,
	timeclock: status,
	schedule: status,
	hiring: status,
})

describe('staff route loaders', () => {
	it('every loader returns 404 to an admin while staffing is off (default)', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect(await runAll(organization.slug, cookie)).toEqual(ALL(404))
	})

	it('guards each child on its own, so skipping the layout loader opens nothing', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		// Master only: Team opens, the other sections stay closed.
		expect(await run('team', organization.slug, cookie)).toBe('ok')
		expect(await run('timeclock', organization.slug, cookie)).toBe(404)
		expect(await run('schedule', organization.slug, cookie)).toBe(404)
		expect(await run('hiring', organization.slug, cookie)).toBe(404)
	})

	it('opens a section when the master and its own flag are both on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		await setFlag('timeclock', organization.id)
		await setFlag('scheduling', organization.id)
		await setFlag('hiring', organization.id)
		expect(await runAll(organization.slug, cookie)).toEqual(ALL('ok'))
	})

	it('returns 403 to a built-in member even with every flag on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('member')
		for (const feature of Object.keys(
			STAFFING_FLAG_KEYS,
		) as StaffingFeature[]) {
			await setFlag(feature, organization.id)
		}
		expect(await runAll(organization.slug, cookie)).toEqual(ALL(403))
	})

	it('does not open another organization to an admin of a different one', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		await setFlag('enabled', b.organization.id)
		expect(await runAll(b.organization.slug, a.cookie)).toEqual(ALL(404))
	})
})
