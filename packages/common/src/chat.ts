import { z } from 'zod'

/**
 * Wire protocol for team chat. Shared by the `ChatOrg` Durable Object (server),
 * its engine tests, and the browser client so both ends validate the same shapes.
 *
 * One WebSocket per user per organization carries every channel. Authorization
 * is decided server-side per frame; the client never asserts who it is or which
 * channels it may read.
 */

export const CHAT_LIMITS = {
	bodyMax: 4000,
	nameMax: 80,
	descriptionMax: 280,
	historyPage: 50,
	historyPageMax: 100,
	threadPage: 50,
	threadPageMax: 100,
	syncChannelsMax: 200,
	emojiMax: 32,
	reactionsPerMessage: 20,
	frameBytesMax: 16 * 1024,
	/** Collapse message bodies longer than this in the UI. */
	collapseBodyAt: 600,
	/** Distinct explicit members + roles on one channel. */
	audienceEntriesMax: 500,
	groupMembersMax: 50,
	attachmentsMax: 3,
	searchQueryMax: 200,
	searchResultsMax: 50,
} as const

/** Allowed retention windows; `null` means keep messages forever. */
export const CHAT_RETENTION_DAY_OPTIONS = [30, 90, 365] as const

export type ChatRetentionDays =
	(typeof CHAT_RETENTION_DAY_OPTIONS)[number] | null

export type ChatChannelKind = 'channel' | 'dm' | 'group'

const requestId = z.string().min(1).max(64)
const channelId = z.string().min(1).max(64)
const messageId = z.number().int().positive()
const messageBody = z.string().max(CHAT_LIMITS.bodyMax)

/** Reactions are Unicode emoji only; free text would turn into a chat channel. */
export function isValidReactionEmoji(value: string) {
	return (
		value.length > 0 &&
		value.length <= CHAT_LIMITS.emojiMax &&
		!/\s/u.test(value) &&
		/\p{Extended_Pictographic}|\p{Regional_Indicator}|^[0-9#*]\uFE0F?\u20E3$/u.test(
			value,
		)
	)
}

export const chatClientFrameSchema = z.discriminatedUnion('t', [
	z.object({
		t: z.literal('history'),
		id: requestId,
		channel: channelId,
		before: messageId.optional(),
		limit: z.number().int().min(1).max(CHAT_LIMITS.historyPageMax).optional(),
	}),
	z.object({
		t: z.literal('thread'),
		id: requestId,
		channel: channelId,
		parent: messageId,
		/** Return replies older than this id (pages upward through the thread). */
		before: messageId.optional(),
		limit: z.number().int().min(1).max(CHAT_LIMITS.threadPageMax).optional(),
	}),
	z.object({
		t: z.literal('send'),
		id: requestId,
		channel: channelId,
		/** Empty when the message is attachment-only; validated in the chat engine. */
		body: messageBody.default(''),
		parent: messageId.optional(),
		attachmentKeys: z
			.array(z.string().min(1).max(512))
			.max(CHAT_LIMITS.attachmentsMax)
			.optional(),
	}),
	z.object({
		t: z.literal('search'),
		id: requestId,
		query: z.string().trim().min(1).max(CHAT_LIMITS.searchQueryMax),
		channels: z.array(channelId).min(1).max(CHAT_LIMITS.syncChannelsMax),
		limit: z.number().int().min(1).max(CHAT_LIMITS.searchResultsMax).optional(),
	}),
	z.object({
		t: z.literal('edit'),
		id: requestId,
		message: messageId,
		body: z.string().trim().min(1).max(CHAT_LIMITS.bodyMax),
	}),
	z.object({ t: z.literal('delete'), id: requestId, message: messageId }),
	z.object({
		t: z.literal('react'),
		id: requestId,
		message: messageId,
		emoji: z.string().refine(isValidReactionEmoji, 'Invalid emoji'),
	}),
	z.object({
		t: z.literal('read'),
		id: requestId,
		channel: channelId,
		upTo: messageId,
	}),
	z.object({ t: z.literal('typing'), channel: channelId }),
	z.object({
		t: z.literal('sync'),
		id: requestId,
		channels: z.array(channelId).max(CHAT_LIMITS.syncChannelsMax),
	}),
	z.object({ t: z.literal('ping') }),
])

export type ChatClientFrame = z.infer<typeof chatClientFrameSchema>

export type ChatPerson = { id: string; name: string; image: string | null }

export type ChatReaction = { emoji: string; userIds: string[] }

export type ChatMessageAttachment = { objectKey: string }

export type ChatMessage = {
	id: number
	channel: string
	/** Parent message id for thread replies; `null` for top-level messages. */
	parent: number | null
	author: string
	/** Empty when `deleted`. */
	body: string
	attachments: ChatMessageAttachment[]
	createdAt: number
	editedAt: number | null
	deleted: boolean
	replyCount: number
	lastReplyAt: number | null
	reactions: ChatReaction[]
}

export type ChatSearchHit = {
	id: number
	channel: string
	body: string
	createdAt: number
	author: string
}

export type ChatUnread = {
	channel: string
	unread: number
	lastReadId: number
	latestId: number
}

export type ChatErrorCode =
	| 'bad_request'
	| 'forbidden'
	| 'not_found'
	| 'rate_limited'
	| 'conflict'
	| 'internal'

export type ChatServerFrame =
	| {
			t: 'ready'
			me: { id: string; canModerate: boolean }
			online: string[]
	  }
	| {
			t: 'ack'
			id: string
			ok: true
			data?: unknown
	  }
	| {
			t: 'ack'
			id: string
			ok: false
			error: ChatErrorCode
			message: string
	  }
	| {
			t: 'message'
			message: ChatMessage
			people: ChatPerson[]
	  }
	| { t: 'message.updated'; message: ChatMessage }
	| {
			t: 'message.deleted'
			channel: string
			id: number
			parent: number | null
	  }
	| {
			t: 'reactions'
			channel: string
			message: number
			reactions: ChatReaction[]
	  }
	| { t: 'typing'; channel: string; user: string }
	| { t: 'presence'; user: string; online: boolean }
	| { t: 'channel.deleted'; channel: string }
	| { t: 'channels.changed' }
	| { t: 'pong' }

export type ChatHistoryResult = {
	messages: ChatMessage[]
	people: ChatPerson[]
	hasMore: boolean
}

export type ChatThreadResult = {
	parent: ChatMessage
	/** One page of replies, oldest first. The newest page is returned first. */
	replies: ChatMessage[]
	people: ChatPerson[]
	/** Older replies exist beyond this page. */
	hasMore: boolean
}

/** What a tenant admin submits when creating or editing a channel. */
export const chatChannelInputSchema = z
	.object({
		name: z
			.string()
			.trim()
			.min(1, 'Give the channel a name.')
			.max(CHAT_LIMITS.nameMax),
		description: z.string().trim().max(CHAT_LIMITS.descriptionMax).default(''),
		access: z.enum(['everyone', 'restricted']),
		roleIds: z.array(z.string().min(1).max(64)).default([]),
		memberIds: z.array(z.string().min(1).max(64)).default([]),
	})
	.transform((value) => ({
		...value,
		// A restricted channel's audience is its roles plus its named members;
		// `everyone` channels ignore both so stale selections never linger.
		roleIds: value.access === 'restricted' ? [...new Set(value.roleIds)] : [],
		memberIds:
			value.access === 'restricted' ? [...new Set(value.memberIds)] : [],
	}))
	.refine(
		(value) =>
			value.access !== 'restricted' ||
			value.roleIds.length + value.memberIds.length > 0,
		{
			message: 'Choose at least one role or member for a restricted channel.',
			path: ['roleIds'],
		},
	)
	.refine(
		(value) =>
			value.roleIds.length + value.memberIds.length <=
			CHAT_LIMITS.audienceEntriesMax,
		{ message: 'Too many roles and members selected.', path: ['memberIds'] },
	)

export type ChatChannelInput = z.infer<typeof chatChannelInputSchema>

/** A channel as the member list shows it. */
export type ChatChannelSummary = {
	id: string
	name: string
	description: string
	access: 'everyone' | 'restricted'
	kind: ChatChannelKind
	/** Other participant in a DM (for avatars and labels). */
	peerUserId?: string | null
	createdById?: string | null
	showHistoryToNewMembers?: boolean
}

/** A channel with its audience, for the manage page. */
export type ChatChannelDetail = ChatChannelSummary & {
	roleIds: string[]
	memberIds: string[]
}
