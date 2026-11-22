import {
	ConfigFlag,
	db,
	eq,
	inArray,
	OrderAlertRecipient,
	OrganizationLocation,
	Organization,
} from '@repo/database'
import type * as EmailModule from '@repo/email'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendEmailMock = vi.hoisted(() => vi.fn())
vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<typeof EmailModule>()),
	sendEmail: sendEmailMock,
}))

import {
	getMockAlertTextProvider,
	setAlertTextProvider,
} from '#app/utils/alerts/text.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './locations_.$locationId.order-alerts.ts'

const flagIds: string[] = []
const texts = getMockAlertTextProvider()

async function turnOn(organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: 'orders.manager_alerts',
			value: true,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

async function location(organizationId: string) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name: 'Downtown',
			slug: `loc-${crypto.randomUUID().slice(0, 8)}`,
		})
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

async function load(slug: string, locationId: string, cookie: string) {
	const request = createAuthenticatedRequest(
		`https://app.test/${slug}/settings/locations/${locationId}/order-alerts`,
		{},
		cookie,
	)
	try {
		return (await loader({
			request,
			params: { orgSlug: slug, locationId },
			context: {},
		} as never)) as Response
	} catch (error) {
		if (error instanceof Response) return error
		throw error
	}
}

async function post(
	slug: string,
	locationId: string,
	cookie: string,
	values: Record<string, string>,
) {
	const request = createAuthenticatedRequest(
		`https://app.test/${slug}/settings/locations/${locationId}/order-alerts`,
		{ method: 'POST', body: new URLSearchParams(values) },
		cookie,
	)
	try {
		return (await action({
			request,
			params: { orgSlug: slug, locationId },
			context: {},
		} as never)) as Response
	} catch (error) {
		if (error instanceof Response) return error
		throw error
	}
}

beforeEach(() => {
	sendEmailMock.mockReset().mockResolvedValue({ status: 'success', data: {} })
	texts.reset()
	setAlertTextProvider(texts)
})

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
	setAlertTextProvider(null)
})

describe('Order alerts settings of a location (#131, #241, #300)', () => {
	it('offers nothing and writes nothing while the organization has them off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const place = await location(organization.id)
		expect(await (await load(organization.slug, place, cookie)).json()).toEqual(
			{
				enabled: false,
			},
		)
		const response = await post(organization.slug, place, cookie, {
			intent: 'add_recipient',
			address: 'owner@example.com',
		})
		expect(getResponseStatus(response)).toBe(404)
		expect(await db.select().from(OrderAlertRecipient)).toHaveLength(0)
	})

	it('refuses a member without update:settings:any, and shows read-only to one who may only read', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const place = await location(organization.id)
		const viewer = await createTestUser()
		await addOrganizationMember(viewer.id, organization.id, 'org_role_viewer')
		const { createTestSession } = await import('#tests/test-utils.ts')
		const { cookie } = await createTestSession(viewer.id)
		const response = await post(organization.slug, place, cookie, {
			intent: 'add_recipient',
			address: 'owner@example.com',
		})
		expect(getResponseStatus(response)).toBe(403)
		expect(await db.select().from(OrderAlertRecipient)).toHaveLength(0)
	})

	it('adds a recipient, sends a code, and confirms only with the right one', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const place = await location(organization.id)
		const added = await post(organization.slug, place, cookie, {
			intent: 'add_recipient',
			address: 'Owner@Example.com',
		})
		const body = (await added.json()) as {
			ok: boolean
			recipients: Array<{ id: string; address: string; verified: boolean }>
		}
		expect(body.ok).toBe(true)
		expect(body.recipients).toMatchObject([
			{ address: 'owner@example.com', verified: false },
		])
		const subject = (sendEmailMock.mock.calls.at(-1)![0] as { subject: string })
			.subject
		const code = /(\d{6})/.exec(subject)![1]!
		const id = body.recipients[0]!.id

		const wrong = await post(organization.slug, place, cookie, {
			intent: 'confirm',
			recipientId: id,
			code: code === '111111' ? '222222' : '111111',
		})
		expect(wrong.status).toBe(400)
		const right = await post(organization.slug, place, cookie, {
			intent: 'confirm',
			recipientId: id,
			code,
		})
		const confirmed = (await right.json()) as {
			recipients: Array<{ verified: boolean }>
		}
		expect(confirmed.recipients[0]!.verified).toBe(true)
	})

	it('texts the code to a mobile number, and refuses a number for a Saudi organization', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const place = await location(organization.id)
		const response = await post(organization.slug, place, cookie, {
			intent: 'add_recipient',
			address: '(415) 555-0100',
		})
		expect(response.status).toBe(200)
		expect(texts.sent).toHaveLength(1)
		expect(texts.sent[0]!.to).toBe('+14155550100')
		expect(texts.sent[0]!.text).toMatch(/code is \d{6}/)

		await db
			.update(Organization)
			.set({ dataRegion: 'ksa' })
			.where(eq(Organization.id, organization.id))
		const refused = await post(organization.slug, place, cookie, {
			intent: 'add_recipient',
			address: '+966501234567',
		})
		expect(refused.status).toBe(400)
		expect(((await refused.json()) as { error: string }).error).toBe(
			'sms_unavailable',
		)
		expect(texts.sent).toHaveLength(1)
	})

	it('allows at most five recipients per location', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const place = await location(organization.id)
		for (let i = 0; i < 5; i++) {
			const ok = await post(organization.slug, place, cookie, {
				intent: 'add_recipient',
				address: `person${i}@example.com`,
			})
			expect(ok.status).toBe(200)
		}
		const sixth = await post(organization.slug, place, cookie, {
			intent: 'add_recipient',
			address: 'person6@example.com',
		})
		expect(sixth.status).toBe(400)
		expect(((await sixth.json()) as { error: string }).error).toBe(
			'limit_reached',
		)
	})

	it('removes a recipient at once, and never one of another organization', async () => {
		const mine = await setupTestOrgWithUser('admin')
		const theirs = await setupTestOrgWithUser('admin')
		await turnOn(mine.organization.id)
		await turnOn(theirs.organization.id)
		const myPlace = await location(mine.organization.id)
		const theirPlace = await location(theirs.organization.id)
		const added = (await (
			await post(theirs.organization.slug, theirPlace, theirs.cookie, {
				intent: 'add_recipient',
				address: 'theirs@example.com',
			})
		).json()) as { recipients: Array<{ id: string }> }
		const theirId = added.recipients[0]!.id
		// My admin cannot remove it through my own location.
		const sneaky = await post(mine.organization.slug, myPlace, mine.cookie, {
			intent: 'remove',
			recipientId: theirId,
		})
		expect(sneaky.status).toBe(404)
		const theirs_ = () =>
			db
				.select()
				.from(OrderAlertRecipient)
				.where(eq(OrderAlertRecipient.organizationId, theirs.organization.id))
		expect(await theirs_()).toHaveLength(1)
		const removed = await post(
			theirs.organization.slug,
			theirPlace,
			theirs.cookie,
			{
				intent: 'remove',
				recipientId: theirId,
			},
		)
		expect(
			((await removed.json()) as { recipients: unknown[] }).recipients,
		).toHaveLength(0)
		expect(await theirs_()).toHaveLength(0)
	})

	it('saves the waiting limit and the large-order alert, and reads them back', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const place = await location(organization.id)
		const saved = await post(organization.slug, place, cookie, {
			intent: 'save_settings',
			waitingMinutes: '15',
			largeEnabled: 'true',
			largeItems: '12',
			largeAmount: '',
			largeRemind: '90',
		})
		expect(saved.status).toBe(200)
		const view = (await (
			await load(organization.slug, place, cookie)
		).json()) as {
			waitingMinutes: number | null
			largeOrder: {
				enabled: boolean
				itemThreshold: number | null
				remindMinutes: number
			}
		}
		expect(view.waitingMinutes).toBe(15)
		expect(view.largeOrder).toMatchObject({
			enabled: true,
			itemThreshold: 12,
			remindMinutes: 90,
		})
		// Blank goes back to the default.
		await post(organization.slug, place, cookie, {
			intent: 'save_settings',
			waitingMinutes: '',
			largeEnabled: 'false',
			largeItems: '',
			largeAmount: '',
			largeRemind: '60',
		})
		const again = (await (
			await load(organization.slug, place, cookie)
		).json()) as {
			waitingMinutes: number | null
		}
		expect(again.waitingMinutes).toBeNull()
		// Out of range is refused.
		const bad = await post(organization.slug, place, cookie, {
			intent: 'save_settings',
			waitingMinutes: '1',
			largeEnabled: 'false',
			largeItems: '',
			largeAmount: '',
			largeRemind: '60',
		})
		expect(bad.status).toBe(400)
	})
})
