import { faker } from '@faker-js/faker'
import { chatChannelInputSchema } from '@repo/common/chat'
import {
	db,
	eq,
	OrganizationChatChannel,
	OrganizationChatChannelMember,
	OrganizationChatChannelRole,
	OrganizationRole,
	UserOrganization,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import {
	addOrganizationMember,
	createTestOrganization,
	createTestUser,
} from '#tests/test-utils.ts'
import {
	isActiveOrganizationMember,
	resolveChannelAudiences,
} from './audience.server.ts'
import {
	ChatChannelError,
	createChannel,
	deleteChannel,
	listChannelsForManager,
	listChannelsForUser,
	updateChannel,
} from './channels.server.ts'

function input(overrides: Record<string, unknown> = {}) {
	return chatChannelInputSchema.parse({
		name: `chan-${faker.string.alphanumeric(8)}`,
		access: 'everyone',
		...overrides,
	})
}

async function setup() {
	const alice = await createTestUser() // admin
	const org = await createTestOrganization(alice.id, 'admin')
	const bob = await createTestUser() // member
	const carol = await createTestUser() // viewer
	const dave = await createTestUser() // not in the org
	await addOrganizationMember(bob.id, org.id, 'org_role_member')
	await addOrganizationMember(carol.id, org.id, 'org_role_viewer')
	return { org, alice, bob, carol, dave }
}

async function audienceOf(orgId: string, channelId: string) {
	const audiences = await resolveChannelAudiences(orgId, [channelId])
	return [...(audiences.get(channelId) ?? [])].sort()
}

describe('team chat channel access', () => {
	it('admits every active member of an everyone channel, and nobody else', async () => {
		const { org, alice, bob, carol, dave } = await setup()
		const channelId = await createChannel(org.id, alice.id, input())
		expect(await audienceOf(org.id, channelId)).toEqual(
			[alice.id, bob.id, carol.id].sort(),
		)
		expect(await audienceOf(org.id, channelId)).not.toContain(dave.id)
	})

	it('removes deactivated members from the audience', async () => {
		const { org, alice, bob } = await setup()
		const channelId = await createChannel(org.id, alice.id, input())
		await db
			.update(UserOrganization)
			.set({ active: false })
			.where(eq(UserOrganization.userId, bob.id))
		expect(await audienceOf(org.id, channelId)).not.toContain(bob.id)
		expect(await isActiveOrganizationMember(org.id, bob.id)).toBe(false)
		expect(await listChannelsForUser(org.id, bob.id)).toEqual([])
	})

	it('restricts by role, and being an admin does not grant entry', async () => {
		const { org, alice, bob, carol } = await setup()
		const channelId = await createChannel(
			org.id,
			alice.id,
			input({
				access: 'restricted',
				roleIds: ['org_role_viewer'],
				memberIds: [],
			}),
		)
		const audience = await audienceOf(org.id, channelId)
		// Alice created it, so she is named explicitly; bob (member) is out.
		expect(audience).toEqual([alice.id, carol.id].sort())
		expect(audience).not.toContain(bob.id)
	})

	it('restricts by individual member', async () => {
		const { org, alice, bob, carol } = await setup()
		const channelId = await createChannel(
			org.id,
			alice.id,
			input({ access: 'restricted', memberIds: [bob.id] }),
		)
		expect(await audienceOf(org.id, channelId)).toEqual(
			[alice.id, bob.id].sort(),
		)
		expect(await audienceOf(org.id, channelId)).not.toContain(carol.id)
	})

	it('keeps the creator in a restricted channel so they cannot lock themselves out', async () => {
		const { org, alice } = await setup()
		const channelId = await createChannel(
			org.id,
			alice.id,
			input({ access: 'restricted', roleIds: ['org_role_viewer'] }),
		)
		const [detail] = await listChannelsForManager(org.id)
		expect(detail?.id).toBe(channelId)
		expect(detail?.memberIds).toContain(alice.id)
	})

	it('the member list and the realtime audience always agree', async () => {
		const { org, alice, bob, carol, dave } = await setup()
		const ids = [
			await createChannel(org.id, alice.id, input()),
			await createChannel(
				org.id,
				alice.id,
				input({ access: 'restricted', roleIds: ['org_role_viewer'] }),
			),
			await createChannel(
				org.id,
				alice.id,
				input({ access: 'restricted', memberIds: [bob.id] }),
			),
			await createChannel(
				org.id,
				alice.id,
				input({
					access: 'restricted',
					roleIds: ['org_role_member'],
					memberIds: [carol.id],
				}),
			),
		]
		const audiences = await resolveChannelAudiences(org.id, ids)
		for (const user of [alice, bob, carol, dave]) {
			const visible = new Set(
				(await listChannelsForUser(org.id, user.id)).map((c) => c.id),
			)
			for (const id of ids) {
				expect(visible.has(id), `${user.id} on ${id}`).toBe(
					audiences.get(id)!.has(user.id),
				)
			}
		}
	})

	it("never resolves another organization's channels", async () => {
		const first = await setup()
		const second = await setup()
		const channelId = await createChannel(first.org.id, first.alice.id, input())
		const audiences = await resolveChannelAudiences(second.org.id, [channelId])
		expect(audiences.get(channelId)?.size).toBe(0)
		expect(await listChannelsForUser(second.org.id, second.alice.id)).toEqual(
			[],
		)
		// A user from the other org gets nothing from this org's list either.
		expect(await listChannelsForUser(first.org.id, second.alice.id)).toEqual([])
	})

	it('treats unknown channel ids as an empty audience', async () => {
		const { org } = await setup()
		const audiences = await resolveChannelAudiences(org.id, ['nope'])
		expect([...(audiences.get('nope') ?? [])]).toEqual([])
	})

	it('resolves many channels in one call', async () => {
		const { org, alice, bob } = await setup()
		const ids: string[] = []
		for (let index = 0; index < 60; index++) {
			ids.push(
				await createChannel(
					org.id,
					alice.id,
					input({
						name: `bulk-${index}`,
						access: index % 2 === 0 ? 'everyone' : 'restricted',
						memberIds: index % 2 === 0 ? [] : [bob.id],
					}),
				),
			)
		}
		const audiences = await resolveChannelAudiences(org.id, ids)
		expect(audiences.size).toBe(60)
		for (const id of ids) expect(audiences.get(id)!.has(bob.id)).toBe(true)
	})
})

describe('team chat channel management', () => {
	it('rejects roles and members from another organization', async () => {
		const { org, alice } = await setup()
		const other = await setup()
		const [foreignRole] = await db
			.insert(OrganizationRole)
			.values({
				name: `Foreign ${faker.string.alphanumeric(6)}`,
				level: 5,
				organizationId: other.org.id,
			})
			.returning()
		await expect(
			createChannel(
				org.id,
				alice.id,
				input({ access: 'restricted', roleIds: [foreignRole!.id] }),
			),
		).rejects.toMatchObject({ field: 'roleIds' })
		await expect(
			createChannel(
				org.id,
				alice.id,
				input({ access: 'restricted', memberIds: [other.bob.id] }),
			),
		).rejects.toMatchObject({ field: 'memberIds' })
		// Nothing was created by the failed attempts.
		expect(await listChannelsForManager(org.id)).toEqual([])
	})

	it('rejects deactivated members as audience', async () => {
		const { org, alice, bob } = await setup()
		await db
			.update(UserOrganization)
			.set({ active: false })
			.where(eq(UserOrganization.userId, bob.id))
		await expect(
			createChannel(
				org.id,
				alice.id,
				input({ access: 'restricted', memberIds: [bob.id] }),
			),
		).rejects.toBeInstanceOf(ChatChannelError)
	})

	it('rejects duplicate names case-insensitively, but not across organizations', async () => {
		const { org, alice } = await setup()
		await createChannel(org.id, alice.id, input({ name: 'Announcements' }))
		await expect(
			createChannel(org.id, alice.id, input({ name: 'announcements' })),
		).rejects.toMatchObject({ field: 'name' })
		const other = await setup()
		await expect(
			createChannel(
				other.org.id,
				other.alice.id,
				input({ name: 'Announcements' }),
			),
		).resolves.toBeTruthy()
	})

	it('updates access without ever leaving a restricted channel empty or open', async () => {
		const { org, alice, bob, carol } = await setup()
		const channelId = await createChannel(
			org.id,
			alice.id,
			input({ name: 'ops', access: 'restricted', memberIds: [bob.id] }),
		)
		expect(await audienceOf(org.id, channelId)).toEqual(
			[alice.id, bob.id].sort(),
		)

		// Swap bob for carol: bob loses access, carol gains it.
		await updateChannel(
			org.id,
			channelId,
			input({
				name: 'ops',
				access: 'restricted',
				memberIds: [alice.id, carol.id],
			}),
		)
		expect(await audienceOf(org.id, channelId)).toEqual(
			[alice.id, carol.id].sort(),
		)

		// Open it up: stale audience rows are cleared, everyone gets in.
		await updateChannel(org.id, channelId, input({ name: 'ops-all' }))
		expect(await audienceOf(org.id, channelId)).toEqual(
			[alice.id, bob.id, carol.id].sort(),
		)
		const rows = await db
			.select()
			.from(OrganizationChatChannelMember)
			.where(eq(OrganizationChatChannelMember.channelId, channelId))
		expect(rows).toEqual([])
	})

	it('lets a channel keep its own name when edited', async () => {
		const { org, alice } = await setup()
		const channelId = await createChannel(
			org.id,
			alice.id,
			input({ name: 'general' }),
		)
		await expect(
			updateChannel(
				org.id,
				channelId,
				input({ name: 'General', description: 'Anything goes' }),
			),
		).resolves.toBeUndefined()
	})

	it('cannot update or delete a channel from another organization', async () => {
		const first = await setup()
		const second = await setup()
		const channelId = await createChannel(
			first.org.id,
			first.alice.id,
			input({ name: 'private-to-first' }),
		)
		await expect(
			updateChannel(second.org.id, channelId, input({ name: 'hijacked' })),
		).rejects.toBeInstanceOf(ChatChannelError)
		await expect(
			deleteChannel(second.org.id, channelId),
		).rejects.toBeInstanceOf(ChatChannelError)
		const [channel] = await db
			.select()
			.from(OrganizationChatChannel)
			.where(eq(OrganizationChatChannel.id, channelId))
		expect(channel?.name).toBe('private-to-first')
	})

	it('deleting a channel removes its access rows', async () => {
		const { org, alice, bob } = await setup()
		const channelId = await createChannel(
			org.id,
			alice.id,
			input({
				access: 'restricted',
				roleIds: ['org_role_viewer'],
				memberIds: [bob.id],
			}),
		)
		await deleteChannel(org.id, channelId)
		expect(
			await db
				.select()
				.from(OrganizationChatChannelRole)
				.where(eq(OrganizationChatChannelRole.channelId, channelId)),
		).toEqual([])
		expect(
			await db
				.select()
				.from(OrganizationChatChannelMember)
				.where(eq(OrganizationChatChannelMember.channelId, channelId)),
		).toEqual([])
		expect(await audienceOf(org.id, channelId)).toEqual([])
	})
})

describe('chatChannelInputSchema', () => {
	it('requires an audience for restricted channels', () => {
		const result = chatChannelInputSchema.safeParse({
			name: 'x',
			access: 'restricted',
		})
		expect(result.success).toBe(false)
	})

	it('drops stale audience when a channel is open to everyone', () => {
		const parsed = chatChannelInputSchema.parse({
			name: ' general ',
			access: 'everyone',
			roleIds: ['org_role_admin'],
			memberIds: ['u1'],
		})
		expect(parsed).toMatchObject({
			name: 'general',
			roleIds: [],
			memberIds: [],
		})
	})

	it('de-duplicates and caps the audience', () => {
		const parsed = chatChannelInputSchema.parse({
			name: 'x',
			access: 'restricted',
			memberIds: ['a', 'a', 'b'],
		})
		expect(parsed.memberIds).toEqual(['a', 'b'])
		expect(
			chatChannelInputSchema.safeParse({
				name: 'x',
				access: 'restricted',
				memberIds: Array.from({ length: 501 }, (_, index) => `u${index}`),
			}).success,
		).toBe(false)
	})

	it('rejects empty and oversize names', () => {
		expect(
			chatChannelInputSchema.safeParse({ name: '   ', access: 'everyone' })
				.success,
		).toBe(false)
		expect(
			chatChannelInputSchema.safeParse({
				name: 'x'.repeat(81),
				access: 'everyone',
			}).success,
		).toBe(false)
	})
})
