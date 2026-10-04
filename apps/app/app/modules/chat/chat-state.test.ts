import { type ChatMessage, type ChatServerFrame } from '@repo/common/chat'
import { describe, expect, it } from 'vitest'
import {
	TYPING_TTL_MS,
	chatReducer,
	initialChatState,
	totalUnread,
	typingUserIds,
	type ChatAction,
	type ChatState,
} from './chat-state.ts'

function message(
	overrides: Partial<ChatMessage> & { id: number },
): ChatMessage {
	return {
		channel: 'general',
		parent: null,
		author: 'bob',
		body: `m${overrides.id}`,
		createdAt: overrides.id,
		editedAt: null,
		deleted: false,
		replyCount: 0,
		lastReplyAt: null,
		reactions: [],
		attachments: [],
		...overrides,
	}
}

function run(state: ChatState, ...actions: ChatAction[]) {
	return actions.reduce(chatReducer, state)
}

function frame(
	serverFrame: ChatServerFrame,
	options: { now?: number; viewing?: string | null } = {},
): ChatAction {
	return {
		type: 'frame',
		frame: serverFrame,
		now: options.now ?? 1_000,
		viewing: options.viewing ?? null,
	}
}

const ready = frame({
	t: 'ready',
	me: { id: 'me', canModerate: false },
	online: ['bob'],
})

const person = { id: 'bob', name: 'Bob', image: null }

describe('chatReducer', () => {
	it('opens the connection on ready and tracks presence', () => {
		const state = run(
			initialChatState,
			ready,
			frame({ t: 'presence', user: 'alice', online: true }),
			frame({ t: 'presence', user: 'alice', online: true }),
			frame({ t: 'presence', user: 'bob', online: false }),
		)
		expect(state.connection).toBe('open')
		expect(state.me).toEqual({ id: 'me', canModerate: false })
		expect(state.online).toEqual(['alice'])
	})

	it("counts unread for others' messages in channels you are not viewing", () => {
		const state = run(
			initialChatState,
			ready,
			frame({ t: 'message', message: message({ id: 1 }), people: [person] }),
			frame({ t: 'message', message: message({ id: 2 }), people: [] }),
		)
		expect(state.channels.general).toMatchObject({ unread: 2, latestId: 2 })
		expect(state.people.bob).toEqual(person)
		expect(totalUnread(state, ['general', 'other'])).toBe(2)
	})

	it('does not count your own messages or messages in the channel you are viewing', () => {
		const state = run(
			initialChatState,
			ready,
			frame({
				t: 'message',
				message: message({ id: 1, author: 'me' }),
				people: [],
			}),
			frame(
				{ t: 'message', message: message({ id: 2 }), people: [] },
				{ viewing: 'general' },
			),
		)
		expect(state.channels.general).toMatchObject({
			unread: 0,
			lastReadId: 2,
			latestId: 2,
		})
	})

	it('does not double count a message that is delivered twice', () => {
		const incoming = frame({
			t: 'message',
			message: message({ id: 5 }),
			people: [],
		})
		const state = run(initialChatState, ready, incoming, incoming)
		expect(state.channels.general?.unread).toBe(1)
		expect(state.channels.general?.messages).toHaveLength(1)
	})

	it('read clears unread up to the latest message', () => {
		const state = run(
			initialChatState,
			ready,
			frame({ t: 'message', message: message({ id: 3 }), people: [] }),
			{ type: 'read', channel: 'general' },
		)
		expect(state.channels.general).toMatchObject({ unread: 0, lastReadId: 3 })
	})

	it('sync seeds unread counts for channels never opened', () => {
		const state = run(initialChatState, {
			type: 'sync',
			unread: [{ channel: 'random', unread: 4, lastReadId: 2, latestId: 6 }],
		})
		expect(state.channels.random).toMatchObject({ unread: 4, latestId: 6 })
		expect(state.channels.random?.loaded).toBe(false)
	})

	it('keeps replies out of the channel list and into an open thread', () => {
		const parent = message({ id: 1 })
		const reply = message({ id: 2, parent: 1 })
		let state = run(initialChatState, ready, {
			type: 'history',
			channel: 'general',
			mode: 'replace',
			result: { messages: [parent], people: [person], hasMore: false },
		})
		// Reply arrives before the thread is opened: not stored, parent bumps.
		state = run(
			state,
			frame({ t: 'message', message: reply, people: [] }),
			frame({
				t: 'message.updated',
				message: { ...parent, replyCount: 1, lastReplyAt: 2 },
			}),
		)
		expect(state.channels.general?.messages.map((m) => m.id)).toEqual([1])
		expect(state.channels.general?.messages[0]?.replyCount).toBe(1)
		expect(state.threads[1]).toBeUndefined()

		state = run(state, {
			type: 'thread',
			mode: 'replace',
			result: {
				parent: { ...parent, replyCount: 1 },
				replies: [reply],
				people: [],
				hasMore: false,
			},
		})
		const second = message({ id: 3, parent: 1 })
		state = run(state, frame({ t: 'message', message: second, people: [] }))
		expect(state.threads[1]?.map((m) => m.id)).toEqual([2, 3])
		// Reply deleted: removed from the open thread.
		state = run(
			state,
			frame({ t: 'message.deleted', channel: 'general', id: 2, parent: 1 }),
		)
		expect(state.threads[1]?.map((m) => m.id)).toEqual([3])
	})

	it('leaves a tombstone for a deleted top-level message', () => {
		const state = run(
			initialChatState,
			ready,
			frame({
				t: 'message',
				message: message({
					id: 1,
					reactions: [{ emoji: '👍', userIds: ['x'] }],
				}),
				people: [],
			}),
			frame({ t: 'message.deleted', channel: 'general', id: 1, parent: null }),
		)
		expect(state.channels.general?.messages[0]).toMatchObject({
			deleted: true,
			body: '',
			reactions: [],
		})
	})

	it('applies edits and reactions to channel messages and open threads', () => {
		const parent = message({ id: 1 })
		const reply = message({ id: 2, parent: 1 })
		const state = run(
			initialChatState,
			ready,
			{
				type: 'history',
				channel: 'general',
				mode: 'replace',
				result: { messages: [parent], people: [], hasMore: false },
			},
			{
				type: 'thread',
				mode: 'replace',
				result: { parent, replies: [reply], people: [], hasMore: false },
			},
			frame({
				t: 'message.updated',
				message: { ...parent, body: 'edited', editedAt: 9 },
			}),
			frame({
				t: 'reactions',
				channel: 'general',
				message: 2,
				reactions: [{ emoji: '🎉', userIds: ['bob'] }],
			}),
		)
		expect(state.channels.general?.messages[0]).toMatchObject({
			body: 'edited',
			editedAt: 9,
		})
		expect(state.threads[1]?.[0]?.reactions).toEqual([
			{ emoji: '🎉', userIds: ['bob'] },
		])
	})

	it('prepends older history without losing newer messages', () => {
		const state = run(
			initialChatState,
			{
				type: 'history',
				channel: 'general',
				mode: 'replace',
				result: {
					messages: [message({ id: 10 }), message({ id: 11 })],
					people: [],
					hasMore: true,
				},
			},
			frame({ t: 'message', message: message({ id: 12 }), people: [] }),
			{
				type: 'history',
				channel: 'general',
				mode: 'prepend',
				result: {
					messages: [message({ id: 8 }), message({ id: 9 })],
					people: [],
					hasMore: false,
				},
			},
		)
		expect(state.channels.general?.messages.map((m) => m.id)).toEqual([
			8, 9, 10, 11, 12,
		])
		expect(state.channels.general?.hasMore).toBe(false)
	})

	it('a refresh keeps messages that arrived while the request was in flight', () => {
		const state = run(
			initialChatState,
			frame({ t: 'message', message: message({ id: 21 }), people: [] }),
			{
				type: 'history',
				channel: 'general',
				mode: 'replace',
				result: {
					messages: [message({ id: 19 }), message({ id: 20 })],
					people: [],
					hasMore: true,
				},
			},
		)
		expect(state.channels.general?.messages.map((m) => m.id)).toEqual([
			19, 20, 21,
		])
	})

	it('shows typing for other people until it expires, and clears it on send', () => {
		let state = run(
			initialChatState,
			ready,
			frame({ t: 'typing', channel: 'general', user: 'bob' }, { now: 1_000 }),
			frame({ t: 'typing', channel: 'general', user: 'me' }, { now: 1_000 }),
		)
		const view = state.channels.general
		expect(typingUserIds(view, 1_000 + 100)).toEqual(['bob'])
		expect(typingUserIds(view, 1_000 + TYPING_TTL_MS + 1)).toEqual([])
		state = run(
			state,
			frame({ t: 'message', message: message({ id: 1 }), people: [] }),
		)
		expect(typingUserIds(state.channels.general, 1_100)).toEqual([])
	})

	it('drops a channel when it is deleted', () => {
		const state = run(
			initialChatState,
			frame({ t: 'message', message: message({ id: 1 }), people: [] }),
			frame({ t: 'channel.deleted', channel: 'general' }),
		)
		expect(state.channels.general).toBeUndefined()
	})
})
