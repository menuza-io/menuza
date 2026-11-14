import { ConfigFlag, db, inArray } from '@repo/database'
import { afterEach, describe, expect, it } from 'vitest'
import { GUEST_MESSAGES_FLAG_KEY } from '#app/utils/guest-messages/settings.ts'
import {
	createAuthenticatedRequest,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './notifications.tsx'

const createdFlagIds: string[] = []

async function turnOn(organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: GUEST_MESSAGES_FLAG_KEY,
			value: true,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	createdFlagIds.push(row!.id)
}

afterEach(async () => {
	if (createdFlagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, createdFlagIds))
		createdFlagIds.length = 0
	}
})

async function post(
	slug: string,
	cookie: string,
	values: Record<string, string>,
) {
	const request = createAuthenticatedRequest(
		`https://app.test/${slug}/settings/notifications`,
		{ method: 'POST', body: new URLSearchParams(values) },
		cookie,
	)
	try {
		return await action({
			request,
			params: { orgSlug: slug },
			context: {},
		} as never)
	} catch (error) {
		if (error instanceof Response) return error
		throw error
	}
}

async function load(slug: string, cookie: string) {
	const request = createAuthenticatedRequest(
		`https://app.test/${slug}/settings/notifications`,
		{},
		cookie,
	)
	return (await loader({
		request,
		params: { orgSlug: slug },
		context: {},
	} as never)) as {
		guestMessages: {
			switches: { receipt: boolean; ready: boolean; cancelled: boolean }
			canEdit: boolean
		} | null
	}
}

const ALL = { receipt: 'true', ready: 'true', cancelled: 'true' }

describe('guest order messages settings', () => {
	it('refuses a save while the flag is off, and offers nothing', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect(getResponseStatus(await post(organization.slug, cookie, ALL))).toBe(
			404,
		)
		expect((await load(organization.slug, cookie)).guestMessages).toBeNull()
	})

	it('refuses a member without update:settings:any', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('viewer')
		await turnOn(organization.id)
		expect(getResponseStatus(await post(organization.slug, cookie, ALL))).toBe(
			403,
		)
		const loaded = await load(organization.slug, cookie)
		expect(loaded.guestMessages?.canEdit).toBe(false)
		expect(loaded.guestMessages?.switches).toEqual({
			receipt: true,
			ready: true,
			cancelled: true,
		})
	})

	it('defaults to all on, saves and round-trips every switch', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		expect((await load(organization.slug, cookie)).guestMessages).toEqual({
			switches: { receipt: true, ready: true, cancelled: true },
			canEdit: true,
		})
		const saved = await post(organization.slug, cookie, {
			receipt: 'false',
			ready: 'true',
			cancelled: 'false',
		})
		expect(getResponseStatus(saved)).toBe(200)
		expect(
			(await load(organization.slug, cookie)).guestMessages?.switches,
		).toEqual({
			receipt: false,
			ready: true,
			cancelled: false,
		})
		// A second save updates the same row.
		await post(organization.slug, cookie, ALL)
		expect(
			(await load(organization.slug, cookie)).guestMessages?.switches,
		).toEqual({
			receipt: true,
			ready: true,
			cancelled: true,
		})
	})

	it('rejects an invalid body without writing', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const result = await post(organization.slug, cookie, {
			receipt: 'maybe',
			ready: 'true',
			cancelled: 'true',
		})
		expect(getResponseStatus(result)).toBe(400)
	})
})
