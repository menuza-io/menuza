import { randomUUID } from 'node:crypto'
import {
	db,
	eq,
	Organization,
	PlatformMarketingCampaign,
	PlatformMarketingMessage,
	User,
	UserOrganization,
} from '@repo/database'
import type * as database from '@repo/database'
import type * as email from '@repo/email'
import {
	dispatchPlatformCampaign,
	getPlatformCampaign,
	resumeStalePlatformCampaigns,
} from '@repo/marketing/server/platform-campaigns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleError, consoleWarn } from '#tests/setup/setup-test-env.ts'

const sent = vi.hoisted(() => [] as string[])
const sendHooks = vi.hoisted(() => ({
	/** Runs inside each send, before it resolves. */
	onSend: null as null | ((to: string) => Promise<void>),
}))
vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<typeof email>()),
	getEmailProvider: () => 'resend',
	sendEmail: async (input: { to: string }) => {
		sent.push(input.to)
		await sendHooks.onSend?.(input.to)
		// Let the other dispatch interleave between the insert and the send.
		await new Promise((resolve) => setTimeout(resolve, 5))
		return { status: 'success', data: { id: randomUUID() } }
	},
}))

const dbHooks = vi.hoisted(() => ({
	/**
	 * Runs on every `db.update(table).set(values)` and
	 * `db.insert(table).values(values)`; throw to fail that write.
	 */
	onWrite: null as
		null | ((table: unknown, values: Record<string, unknown>) => void),
}))
vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof database>()
	const hooked = { update: 'set', insert: 'values' } as const
	const db = new Proxy(actual.db, {
		get(target, prop, receiver) {
			if (prop !== 'update' && prop !== 'insert') {
				return Reflect.get(target, prop, receiver)
			}
			const method = hooked[prop]
			return (table: never) => {
				const builder = (actual.db[prop] as (table: never) => object)(table)
				return new Proxy(builder, {
					get(builderTarget, builderProp, builderReceiver) {
						const value = Reflect.get(
							builderTarget,
							builderProp,
							builderReceiver,
						)
						if (builderProp !== method) return value
						return (values: Record<string, unknown>) => {
							dbHooks.onWrite?.(table, values)
							return (value as (values: unknown) => unknown).call(
								builderTarget,
								values,
							)
						}
					},
				})
			}
		},
	})
	return { ...actual, db }
})

async function createAudience(size: number) {
	const id = randomUUID()
	const [organization] = await db
		.insert(Organization)
		.values({ name: `Org ${id.slice(0, 6)}`, slug: `org-${id}` })
		.returning()
	const users: { id: string; email: string }[] = []
	for (let i = 0; i < size; i++) {
		users.push(await addMember(organization!.id, `op-${i}-${id}`))
	}
	return { organization: organization!, users }
}

async function addMember(organizationId: string, username: string) {
	const email = `${username}@example.com`
	const [user] = await db.insert(User).values({ username, email }).returning()
	await db.insert(UserOrganization).values({
		userId: user!.id,
		organizationId,
		organizationRoleId: 'org_role_member',
		active: true,
	})
	return { id: user!.id, email }
}

async function createCampaign(
	organizationId: string,
	values: Partial<typeof PlatformMarketingCampaign.$inferInsert> = {},
) {
	const [campaign] = await db
		.insert(PlatformMarketingCampaign)
		.values({
			name: 'Launch',
			channel: 'email',
			subject: 'Hi',
			content: 'Hello',
			status: 'Processing',
			audience: 'organization',
			targetOrganizationId: organizationId,
			...values,
		})
		.returning()
	return campaign!
}

async function campaignRow(id: string) {
	const [row] = await db
		.select()
		.from(PlatformMarketingCampaign)
		.where(eq(PlatformMarketingCampaign.id, id))
	return row!
}

describe('platform campaign dispatch', () => {
	beforeEach(() => {
		// Unconfirmed recipients and timed-out sends are reported with a warning.
		consoleWarn.mockImplementation(() => {})
	})
	afterEach(() => {
		sendHooks.onSend = null
		dbHooks.onWrite = null
	})

	it('two dispatches of one campaign running at once send once per user', async () => {
		const { organization, users } = await createAudience(7)
		const emails = users.map((user) => user.email)
		const campaign = await createCampaign(organization.id)

		await Promise.all([
			dispatchPlatformCampaign(campaign.id),
			dispatchPlatformCampaign(campaign.id),
		])

		expect(sent.filter((to) => emails.includes(to)).sort()).toEqual(
			[...emails].sort(),
		)
		const messages = await db
			.select()
			.from(PlatformMarketingMessage)
			.where(eq(PlatformMarketingMessage.campaignId, campaign.id))
		expect(messages).toHaveLength(7)
	})

	it('surfaces recipients an interrupted dispatch left Processing', async () => {
		const { organization, users } = await createAudience(3)
		const campaign = await createCampaign(organization.id)
		// An earlier dispatch claimed this user and died before recording the
		// outcome: the email may or may not have gone out.
		await db.insert(PlatformMarketingMessage).values({
			campaignId: campaign.id,
			userId: users[0]!.id,
			status: 'Processing',
		})

		await dispatchPlatformCampaign(campaign.id)

		expect(sent).not.toContain(users[0]!.email)
		expect((await campaignRow(campaign.id)).status).toBe('Completed')
		const detail = await getPlatformCampaign(campaign.id)
		expect(detail?.unconfirmedRecipientCount).toBe(1)
		expect(
			detail?.recipients.filter((recipient) => recipient.status === 'Sent'),
		).toHaveLength(2)
	})

	it('times out a hung send, leaves it Processing, and keeps the heartbeat fresh', async () => {
		const { organization, users } = await createAudience(7)
		const longAgo = new Date(Date.now() - 60 * 60 * 1000)
		const campaign = await createCampaign(organization.id, {
			updatedAt: longAgo,
		})
		const hung = users[0]!.email
		const heartbeatAges: number[] = []
		sendHooks.onSend = async (to) => {
			const row = await campaignRow(campaign.id)
			heartbeatAges.push(Date.now() - row.updatedAt.getTime())
			if (to === hung) await new Promise(() => {})
		}

		// Only the hung send may time out: leave normal sends (and a slow CI
		// runner's database writes) plenty of room.
		await dispatchPlatformCampaign(campaign.id, { sendTimeoutMs: 1_500 })

		expect((await campaignRow(campaign.id)).status).toBe('Completed')
		const detail = await getPlatformCampaign(campaign.id)
		expect(detail?.unconfirmedRecipientCount).toBe(1)
		const byEmail = new Map(
			detail?.recipients.map((recipient) => [recipient.email, recipient]),
		)
		expect(byEmail.get(hung)?.status).toBe('Processing')
		for (const user of users.slice(1)) {
			expect(byEmail.get(user.email)?.status).toBe('Sent')
		}
		expect(heartbeatAges).toHaveLength(7)
		for (const age of heartbeatAges) expect(age).toBeLessThan(60_000)
	})

	it('keeps the first audience count when a dispatch resumes', async () => {
		const { organization, users } = await createAudience(2)
		const campaign = await createCampaign(organization.id)
		await dispatchPlatformCampaign(campaign.id)
		expect((await campaignRow(campaign.id)).targetAudienceCount).toBe(2)

		// The audience grows, then a resume runs (the campaign was stuck).
		await addMember(organization.id, `late-${randomUUID()}`)
		await db
			.update(PlatformMarketingCampaign)
			.set({ status: 'Processing' })
			.where(eq(PlatformMarketingCampaign.id, campaign.id))
		await dispatchPlatformCampaign(campaign.id)

		expect((await campaignRow(campaign.id)).targetAudienceCount).toBe(2)
		expect(users).toHaveLength(2)
	})
	it('a failed status write costs only that recipient, not the campaign', async () => {
		consoleError.mockImplementation(() => {})
		const { organization, users } = await createAudience(7)
		const emails = users.map((user) => user.email)
		const campaign = await createCampaign(organization.id)
		let failures = 0
		dbHooks.onWrite = (table, values) => {
			if (
				table === PlatformMarketingMessage &&
				'sentAt' in values &&
				failures === 0
			) {
				failures++
				throw new Error('D1_ERROR: Network connection lost')
			}
		}

		await dispatchPlatformCampaign(campaign.id)

		expect(failures).toBe(1)
		expect(sent.filter((to) => emails.includes(to)).sort()).toEqual(
			[...emails].sort(),
		)
		expect((await campaignRow(campaign.id)).status).toBe('Completed')
		const detail = await getPlatformCampaign(campaign.id)
		// The send whose outcome was lost is reported, never re-sent.
		expect(detail?.unconfirmedRecipientCount).toBe(1)
		expect(
			detail?.recipients.filter((recipient) => recipient.status === 'Sent'),
		).toHaveLength(6)
	})

	it('keeps sending when the heartbeat write fails', async () => {
		consoleError.mockImplementation(() => {})
		const { organization, users } = await createAudience(5)
		const emails = users.map((user) => user.email)
		const campaign = await createCampaign(organization.id)
		let heartbeatFailures = 0
		dbHooks.onWrite = (table, values) => {
			const keys = Object.keys(values)
			if (
				table === PlatformMarketingCampaign &&
				keys.length === 1 &&
				keys[0] === 'updatedAt'
			) {
				heartbeatFailures++
				throw new Error('D1_ERROR: overloaded')
			}
		}

		await dispatchPlatformCampaign(campaign.id)

		expect(heartbeatFailures).toBeGreaterThan(0)
		expect(sent.filter((to) => emails.includes(to)).sort()).toEqual(
			[...emails].sort(),
		)
		expect((await campaignRow(campaign.id)).status).toBe('Completed')
	})

	it('leaves the campaign Processing for a resume when a claim cannot be written', async () => {
		consoleError.mockImplementation(() => {})
		const { organization, users } = await createAudience(3)
		const campaign = await createCampaign(organization.id)
		const unlucky = users[1]!
		// The first insert of the unlucky user's message row fails.
		let insertFailed = false
		dbHooks.onWrite = (table, values) => {
			if (
				table === PlatformMarketingMessage &&
				values.userId === unlucky.id &&
				!insertFailed
			) {
				insertFailed = true
				throw new Error('D1_ERROR: Network connection lost')
			}
		}

		await dispatchPlatformCampaign(campaign.id)

		expect(insertFailed).toBe(true)
		expect(sent).not.toContain(unlucky.email)
		const row = await campaignRow(campaign.id)
		expect(row.status).toBe('Processing')
		// Released, so the next resume does not wait for it to go stale.
		expect(row.updatedAt.getTime()).toBe(0)

		const { resumed } = await resumeStalePlatformCampaigns({
			runInBackground: () => {},
		})
		expect(resumed).toContain(campaign.id)
		await dispatchPlatformCampaign(campaign.id)
		expect(sent.filter((to) => to === unlucky.email)).toHaveLength(1)
		expect((await campaignRow(campaign.id)).status).toBe('Completed')
	})

	it('stops between sends when its budget runs out and hands the rest on', async () => {
		const { organization, users } = await createAudience(6)
		const emails = users.map((user) => user.email)
		const campaign = await createCampaign(organization.id)

		await dispatchPlatformCampaign(campaign.id, { budgetMs: 0 })

		expect(sent.filter((to) => emails.includes(to))).toHaveLength(0)
		const row = await campaignRow(campaign.id)
		expect(row.status).toBe('Processing')
		expect(row.updatedAt.getTime()).toBe(0)

		await dispatchPlatformCampaign(campaign.id)
		expect(sent.filter((to) => emails.includes(to)).sort()).toEqual(
			[...emails].sort(),
		)
		const detail = await getPlatformCampaign(campaign.id)
		expect(detail?.status).toBe('Completed')
		expect(detail?.unconfirmedRecipientCount).toBe(0)
	})
})
