import {
	and,
	db,
	eq,
	inArray,
	OrganizationChatChannel,
	OrganizationChatChannelMember,
	OrganizationChatChannelRole,
	UserOrganization,
} from '@repo/database'

/** D1 allows 100 bound parameters per statement; leave room for the org id. */
const ID_CHUNK = 50

function chunk<T>(items: T[], size = ID_CHUNK) {
	const chunks: T[][] = []
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size))
	}
	return chunks
}

/**
 * Who may read and post in each channel, straight from the control plane.
 *
 * This is the only place channel access is decided. The chat Durable Object
 * calls it (batched, cached for a few seconds) and trusts nothing else, so the
 * rules cannot drift between the HTTP pages and the realtime path:
 *
 * - the user must be an **active** member of the organization, always;
 * - `everyone` channels admit every active member;
 * - `restricted` channels admit active members whose role is listed **or** who
 *   are listed individually. Holding `update:chat:any` does not grant entry.
 *
 * Channels that do not exist, or belong to another organization, resolve to an
 * empty audience (never to an error), so an unknown id and a forbidden id are
 * indistinguishable to callers.
 */
export async function resolveChannelAudiences(
	organizationId: string,
	channelIds: string[],
): Promise<Map<string, Set<string>>> {
	const audiences = new Map<string, Set<string>>(
		channelIds.map((id) => [id, new Set<string>()]),
	)
	if (channelIds.length === 0) return audiences

	const channels: {
		id: string
		access: 'everyone' | 'restricted'
		kind: 'channel' | 'dm' | 'group'
	}[] = []
	for (const ids of chunk([...new Set(channelIds)])) {
		channels.push(
			...(await db
				.select({
					id: OrganizationChatChannel.id,
					access: OrganizationChatChannel.access,
					kind: OrganizationChatChannel.kind,
				})
				.from(OrganizationChatChannel)
				.where(
					and(
						eq(OrganizationChatChannel.organizationId, organizationId),
						inArray(OrganizationChatChannel.id, ids),
					),
				)),
		)
	}
	if (channels.length === 0) return audiences

	const members = await db
		.select({
			userId: UserOrganization.userId,
			roleId: UserOrganization.organizationRoleId,
		})
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
			),
		)

	const restrictedIds = channels
		.filter(
			(channel) =>
				channel.kind === 'dm' ||
				channel.kind === 'group' ||
				channel.access === 'restricted',
		)
		.map((channel) => channel.id)
	const roleIdsByChannel = new Map<string, Set<string>>()
	const userIdsByChannel = new Map<string, Set<string>>()
	for (const ids of chunk(restrictedIds)) {
		const [roleRows, memberRows] = await Promise.all([
			db
				.select({
					channelId: OrganizationChatChannelRole.channelId,
					roleId: OrganizationChatChannelRole.organizationRoleId,
				})
				.from(OrganizationChatChannelRole)
				.where(inArray(OrganizationChatChannelRole.channelId, ids)),
			db
				.select({
					channelId: OrganizationChatChannelMember.channelId,
					userId: OrganizationChatChannelMember.userId,
				})
				.from(OrganizationChatChannelMember)
				.where(inArray(OrganizationChatChannelMember.channelId, ids)),
		])
		for (const row of roleRows) {
			const set = roleIdsByChannel.get(row.channelId) ?? new Set<string>()
			set.add(row.roleId)
			roleIdsByChannel.set(row.channelId, set)
		}
		for (const row of memberRows) {
			const set = userIdsByChannel.get(row.channelId) ?? new Set<string>()
			set.add(row.userId)
			userIdsByChannel.set(row.channelId, set)
		}
	}

	for (const channel of channels) {
		const audience = audiences.get(channel.id)!
		if (channel.kind === 'channel' && channel.access === 'everyone') {
			for (const member of members) audience.add(member.userId)
			continue
		}
		const roleIds = roleIdsByChannel.get(channel.id)
		const userIds = userIdsByChannel.get(channel.id)
		for (const member of members) {
			if (roleIds?.has(member.roleId) || userIds?.has(member.userId)) {
				audience.add(member.userId)
			}
		}
	}
	return audiences
}

/** Whether `userId` is an active member of the organization. */
export async function isActiveOrganizationMember(
	organizationId: string,
	userId: string,
) {
	const [row] = await db
		.select({ userId: UserOrganization.userId })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
		.limit(1)
	return Boolean(row)
}
