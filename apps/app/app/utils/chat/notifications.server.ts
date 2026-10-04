import { invariant } from '@epic-web/invariant'
import {
	and,
	db,
	eq,
	Notification,
	OrganizationChatChannel,
	OrganizationChatChannelMember,
	User,
	UserOrganization,
} from '@repo/database'
import {
	chatBodyPreview,
	extractChatMentionUserIds,
} from '@repo/common/chat-markdown'
import { type ChatMessage } from '@repo/common/chat'
import { resolveMentionsToUserIds } from '@repo/notifications'
import { resolveChannelAudiences } from '#app/utils/chat/audience.server.ts'
import { sanitizeTextContent } from '#app/utils/content-sanitization.server.ts'

const appUrl = process.env.BASE_URL
invariant(appUrl, 'BASE_URL is required')

export async function notifyChatMessage({
	organizationId,
	organizationSlug,
	authorId,
	message,
}: {
	organizationId: string
	organizationSlug: string
	authorId: string
	message: ChatMessage
}) {
	const [author] = await db
		.select({ name: User.name, username: User.username })
		.from(User)
		.where(eq(User.id, authorId))
		.limit(1)
	const authorName = sanitizeTextContent(
		author?.name?.trim() || author?.username || 'Someone',
	)

	const [channel] = await db
		.select({
			kind: OrganizationChatChannel.kind,
			name: OrganizationChatChannel.name,
		})
		.from(OrganizationChatChannel)
		.where(
			and(
				eq(OrganizationChatChannel.id, message.channel),
				eq(OrganizationChatChannel.organizationId, organizationId),
			),
		)
		.limit(1)

	const chatUrl = `${appUrl}/${organizationSlug}/chat?channel=${message.channel}`
	const preview = chatBodyPreview(message.body)
	const entityId = `${message.channel}:${message.id}`

	const members = await db
		.select({
			userId: UserOrganization.userId,
			user: {
				id: User.id,
				name: User.name,
				username: User.username,
			},
		})
		.from(UserOrganization)
		.innerJoin(User, eq(UserOrganization.userId, User.id))
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
			),
		)

	const mentionIds = await resolveMentionsToUserIds(
		extractChatMentionUserIds(message.body),
		members,
	)
	const audiences = await resolveChannelAudiences(organizationId, [
		message.channel,
	])
	const channelAudience = audiences.get(message.channel) ?? new Set<string>()
	const mentionTargets = mentionIds.filter(
		(id) => id !== authorId && channelAudience.has(id),
	)

	for (const userId of mentionTargets) {
		await upsertChatNotification({
			userId,
			organizationId,
			type: 'chat-mention',
			entityId,
			payload: {
				chatUrl,
				channelName: channel?.name ?? 'Chat',
				authorName,
				preview,
				messageId: message.id,
				channelId: message.channel,
			},
		})
	}

	if (channel?.kind === 'dm') {
		const peers = await db
			.select({ userId: OrganizationChatChannelMember.userId })
			.from(OrganizationChatChannelMember)
			.where(eq(OrganizationChatChannelMember.channelId, message.channel))
		for (const peer of peers) {
			if (peer.userId === authorId) continue
			await upsertChatNotification({
				userId: peer.userId,
				organizationId,
				type: 'chat-dm',
				entityId,
				payload: {
					chatUrl,
					authorName,
					preview,
					messageId: message.id,
					channelId: message.channel,
				},
			})
		}
	}
}

async function upsertChatNotification(input: {
	userId: string
	organizationId: string
	type: string
	entityId: string
	payload: Record<string, unknown>
}) {
	await db
		.insert(Notification)
		.values({
			userId: input.userId,
			organizationId: input.organizationId,
			type: input.type,
			entityId: input.entityId,
			payload: JSON.stringify(input.payload),
		})
		.onConflictDoUpdate({
			target: [
				Notification.userId,
				Notification.organizationId,
				Notification.type,
				Notification.entityId,
			],
			set: {
				payload: JSON.stringify(input.payload),
				isRead: false,
				isSeen: false,
				updatedAt: new Date(),
			},
		})
}
