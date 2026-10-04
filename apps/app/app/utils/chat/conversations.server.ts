import { CHAT_LIMITS, type ChatChannelSummary } from '@repo/common/chat'
import {
	and,
	db,
	eq,
	inArray,
	OrganizationChatChannel,
	OrganizationChatChannelMember,
	User,
} from '@repo/database'
import { isActiveOrganizationMember } from './audience.server.ts'
import { ChatChannelError } from './channels.server.ts'

export function dmPairKey(userA: string, userB: string) {
	return [userA, userB].sort().join(':')
}

export async function findOrCreateDirectMessage(
	organizationId: string,
	userId: string,
	targetUserId: string,
): Promise<string> {
	if (userId === targetUserId) {
		throw new ChatChannelError('You cannot message yourself.', 'form')
	}
	if (!(await isActiveOrganizationMember(organizationId, targetUserId))) {
		throw new ChatChannelError('That person is not on the team.', 'form')
	}

	const pairKey = dmPairKey(userId, targetUserId)
	const [existing] = await db
		.select({ id: OrganizationChatChannel.id })
		.from(OrganizationChatChannel)
		.where(
			and(
				eq(OrganizationChatChannel.organizationId, organizationId),
				eq(OrganizationChatChannel.dmPairKey, pairKey),
				eq(OrganizationChatChannel.kind, 'dm'),
			),
		)
		.limit(1)
	if (existing) return existing.id

	const [channel] = await db
		.insert(OrganizationChatChannel)
		.values({
			organizationId,
			name: `dm:${pairKey}`,
			description: '',
			access: 'restricted',
			kind: 'dm',
			dmPairKey: pairKey,
			createdById: userId,
		})
		.returning({ id: OrganizationChatChannel.id })
	if (!channel) throw new ChatChannelError('Could not start the chat.', 'form')

	await db.insert(OrganizationChatChannelMember).values([
		{ channelId: channel.id, userId },
		{ channelId: channel.id, userId: targetUserId },
	])

	return channel.id
}

export async function createGroupChat(
	organizationId: string,
	creatorId: string,
	input: {
		name: string
		memberIds: string[]
		showHistoryToNewMembers: boolean
	},
): Promise<string> {
	const members = [...new Set([creatorId, ...input.memberIds])]
	if (members.length < 2) {
		throw new ChatChannelError('Add at least one other person.', 'memberIds')
	}
	if (members.length > CHAT_LIMITS.groupMembersMax) {
		throw new ChatChannelError(
			`A group can have at most ${CHAT_LIMITS.groupMembersMax} people.`,
			'memberIds',
		)
	}
	for (const id of members) {
		if (!(await isActiveOrganizationMember(organizationId, id))) {
			throw new ChatChannelError(
				'Everyone must be an active team member.',
				'memberIds',
			)
		}
	}

	const [channel] = await db
		.insert(OrganizationChatChannel)
		.values({
			organizationId,
			name: input.name.trim(),
			description: '',
			access: 'restricted',
			kind: 'group',
			showHistoryToNewMembers: input.showHistoryToNewMembers,
			createdById: creatorId,
		})
		.returning({ id: OrganizationChatChannel.id })
	if (!channel)
		throw new ChatChannelError('Could not create the group.', 'form')

	await db
		.insert(OrganizationChatChannelMember)
		.values(members.map((userId) => ({ channelId: channel.id, userId })))

	return channel.id
}

export async function addGroupMembers(
	organizationId: string,
	actorId: string,
	channelId: string,
	memberIds: string[],
) {
	const channel = await getGroupChannel(organizationId, channelId)
	if (!channel) throw new ChatChannelError('Group not found.', 'form')

	const [membership] = await db
		.select({ userId: OrganizationChatChannelMember.userId })
		.from(OrganizationChatChannelMember)
		.where(
			and(
				eq(OrganizationChatChannelMember.channelId, channelId),
				eq(OrganizationChatChannelMember.userId, actorId),
			),
		)
		.limit(1)
	if (!membership) {
		throw new ChatChannelError('You are not in this group.', 'form')
	}

	const existing = await db
		.select({ userId: OrganizationChatChannelMember.userId })
		.from(OrganizationChatChannelMember)
		.where(eq(OrganizationChatChannelMember.channelId, channelId))
	const existingIds = new Set(existing.map((row) => row.userId))
	const toAdd = [...new Set(memberIds)].filter((id) => !existingIds.has(id))
	if (toAdd.length === 0) return

	if (existingIds.size + toAdd.length > CHAT_LIMITS.groupMembersMax) {
		throw new ChatChannelError(
			`A group can have at most ${CHAT_LIMITS.groupMembersMax} people.`,
			'memberIds',
		)
	}
	for (const id of toAdd) {
		if (!(await isActiveOrganizationMember(organizationId, id))) {
			throw new ChatChannelError(
				'Everyone must be an active team member.',
				'memberIds',
			)
		}
	}

	await db
		.insert(OrganizationChatChannelMember)
		.values(toAdd.map((userId) => ({ channelId, userId })))
}

export async function updateGroupHistorySetting(
	organizationId: string,
	actorId: string,
	channelId: string,
	showHistoryToNewMembers: boolean,
) {
	const channel = await getGroupChannel(organizationId, channelId)
	if (!channel) throw new ChatChannelError('Group not found.', 'form')
	if (channel.createdById !== actorId) {
		throw new ChatChannelError(
			'Only the person who created this group can change this setting.',
			'form',
		)
	}
	await db
		.update(OrganizationChatChannel)
		.set({ showHistoryToNewMembers, updatedAt: new Date() })
		.where(eq(OrganizationChatChannel.id, channelId))
}

async function getGroupChannel(organizationId: string, channelId: string) {
	const [channel] = await db
		.select({
			id: OrganizationChatChannel.id,
			createdById: OrganizationChatChannel.createdById,
			kind: OrganizationChatChannel.kind,
		})
		.from(OrganizationChatChannel)
		.where(
			and(
				eq(OrganizationChatChannel.id, channelId),
				eq(OrganizationChatChannel.organizationId, organizationId),
				eq(OrganizationChatChannel.kind, 'group'),
			),
		)
		.limit(1)
	return channel ?? null
}

/** Earliest message timestamp a user may read (ms), or null for full history. */
export async function getMessageHistoryCutoff(
	organizationId: string,
	userId: string,
	channelId: string,
): Promise<number | null> {
	const [channel] = await db
		.select({
			kind: OrganizationChatChannel.kind,
			showHistoryToNewMembers: OrganizationChatChannel.showHistoryToNewMembers,
		})
		.from(OrganizationChatChannel)
		.where(
			and(
				eq(OrganizationChatChannel.id, channelId),
				eq(OrganizationChatChannel.organizationId, organizationId),
			),
		)
		.limit(1)
	if (
		!channel ||
		channel.kind === 'channel' ||
		channel.showHistoryToNewMembers
	) {
		return null
	}
	const [member] = await db
		.select({ joinedAt: OrganizationChatChannelMember.joinedAt })
		.from(OrganizationChatChannelMember)
		.where(
			and(
				eq(OrganizationChatChannelMember.channelId, channelId),
				eq(OrganizationChatChannelMember.userId, userId),
			),
		)
		.limit(1)
	return member?.joinedAt?.getTime() ?? Date.now()
}

/** Member user ids per group channel (for roster UI). */
export async function listGroupMemberIdsByChannel(
	channelIds: string[],
): Promise<Record<string, string[]>> {
	if (channelIds.length === 0) return {}
	const rows = await db
		.select({
			channelId: OrganizationChatChannelMember.channelId,
			userId: OrganizationChatChannelMember.userId,
		})
		.from(OrganizationChatChannelMember)
		.where(inArray(OrganizationChatChannelMember.channelId, channelIds))
	const byChannel: Record<string, string[]> = {}
	for (const row of rows) {
		const list = byChannel[row.channelId] ?? []
		list.push(row.userId)
		byChannel[row.channelId] = list
	}
	return byChannel
}

export async function decorateChannelSummaries(
	organizationId: string,
	userId: string,
	channels: ChatChannelSummary[],
): Promise<ChatChannelSummary[]> {
	const dmIds = channels.filter((c) => c.kind === 'dm').map((c) => c.id)
	if (dmIds.length === 0) return channels

	const peers = await db
		.select({
			channelId: OrganizationChatChannelMember.channelId,
			userId: OrganizationChatChannelMember.userId,
		})
		.from(OrganizationChatChannelMember)
		.where(
			and(
				inArray(OrganizationChatChannelMember.channelId, dmIds),
				// not me
			),
		)

	const peerByChannel = new Map<string, string>()
	for (const row of peers) {
		if (row.userId === userId) continue
		peerByChannel.set(row.channelId, row.userId)
	}

	const peerIds = [...new Set(peerByChannel.values())]
	const names = new Map<string, string>()
	if (peerIds.length > 0) {
		const users = await db
			.select({
				id: User.id,
				name: User.name,
				username: User.username,
			})
			.from(User)
			.where(inArray(User.id, peerIds))
		for (const user of users) {
			names.set(user.id, user.name?.trim() || user.username)
		}
	}

	return channels.map((channel) => {
		if (channel.kind !== 'dm') return channel
		const peerUserId = peerByChannel.get(channel.id) ?? null
		return {
			...channel,
			peerUserId,
			name: peerUserId ? (names.get(peerUserId) ?? channel.name) : channel.name,
		}
	})
}
