import { DatabaseSync } from 'node:sqlite'
import { CHAT_LIMITS, type ChatServerFrame } from '@repo/common/chat'
import { describe, expect, it } from 'vitest'
import { CHAT_CLOSE, ChatEngine, type ChatConnection } from './chat-engine.ts'
import { ChatStore, ChatStoreError, type ChatSql } from './chat-store.ts'

function createStore() {
	const db = new DatabaseSync(':memory:')
	const sql: ChatSql = {
		exec: (query, ...bindings) => ({
			toArray: () =>
				db.prepare(query).all(...(bindings as never[])) as Record<
					string,
					unknown
				>[],
		}),
	}
	const store = new ChatStore(sql)
	store.migrate()
	return store
}

type TestConn = ChatConnection & {
	frames: ChatServerFrame[]
	closed: { code: number; reason: string } | null
}

function createHarness(
	initialAudiences: Record<string, string[]>,
	options: {
		audienceTtlMs?: number
		isModerator?: (userId: string) => Promise<boolean>
	} = {},
) {
	const store = createStore()
	const audiences = new Map(
		Object.entries(initialAudiences).map(([channel, users]) => [
			channel,
			new Set(users),
		]),
	)
	const conns: TestConn[] = []
	let clock = 1_000_000
	let resolveCalls = 0
	const engine = new ChatEngine({
		store,
		connections: () => conns.filter((conn) => !conn.closed),
		now: () => clock,
		audienceTtlMs: options.audienceTtlMs,
		isModerator: options.isModerator,
		resolveAudiences: async (ids) => {
			resolveCalls += 1
			return new Map(
				ids.map((id) => [id, new Set(audiences.get(id) ?? [])] as const),
			)
		},
	})
	let nextId = 0
	function connect(userId: string, canModerate = false) {
		const conn: TestConn = {
			id: `c${nextId++}`,
			userId,
			canModerate,
			frames: [],
			closed: null,
			send(frame) {
				conn.frames.push(JSON.parse(frame) as ChatServerFrame)
			},
			close(code, reason) {
				conn.closed = { code, reason }
			},
		}
		conns.push(conn)
		engine.open(conn, { id: userId, name: `User ${userId}`, image: null })
		return conn
	}
	async function send(conn: TestConn, frame: Record<string, unknown>) {
		await engine.handle(conn, JSON.stringify(frame))
	}
	function ack(conn: TestConn, id: string) {
		return conn.frames.find((frame) => frame.t === 'ack' && frame.id === id) as
			Extract<ChatServerFrame, { t: 'ack' }> | undefined
	}
	return {
		engine,
		store,
		audiences,
		connect,
		send,
		ack,
		advance: (ms: number) => {
			clock += ms
		},
		resolveCalls: () => resolveCalls,
	}
}

describe('ChatStore', () => {
	it('pages history newest-first and returns each page oldest-first', () => {
		const store = createStore()
		for (let index = 1; index <= 7; index++) {
			store.addMessage({
				channel: 'c',
				author: 'a',
				body: `m${index}`,
				now: index,
			})
		}
		const first = store.history('c', { limit: 3 })
		expect(first.messages.map((m) => m.body)).toEqual(['m5', 'm6', 'm7'])
		expect(first.hasMore).toBe(true)
		const second = store.history('c', {
			limit: 3,
			before: first.messages[0]!.id,
		})
		expect(second.messages.map((m) => m.body)).toEqual(['m2', 'm3', 'm4'])
		const last = store.history('c', {
			limit: 3,
			before: second.messages[0]!.id,
		})
		expect(last.messages.map((m) => m.body)).toEqual(['m1'])
		expect(last.hasMore).toBe(false)
	})

	it('hydrates pages larger than the SQL bind-parameter limit', () => {
		const store = createStore()
		for (let index = 0; index < 130; index++) {
			store.addMessage({ channel: 'c', author: 'a', body: 'x', now: index })
		}
		const page = store.history('c', { limit: CHAT_LIMITS.historyPageMax })
		expect(page.messages).toHaveLength(100)
	})

	it('keeps channels isolated', () => {
		const store = createStore()
		store.addMessage({ channel: 'a', author: 'u', body: 'secret', now: 1 })
		expect(store.history('b').messages).toEqual([])
	})

	it('persists image attachment keys on messages', () => {
		const store = createStore()
		const key = `orgs/x/media/images/${'a'.repeat(40)}.png`
		const message = store.addMessage({
			channel: 'c',
			author: 'u',
			body: '',
			attachmentKeys: [key],
			now: 1,
		})
		expect(message.attachments).toEqual([{ objectKey: key }])
		expect(store.history('c').messages[0]?.attachments).toEqual([
			{ objectKey: key },
		])
	})

	it('supports one level of replies and counts them', () => {
		const store = createStore()
		const parent = store.addMessage({
			channel: 'c',
			author: 'a',
			body: 'p',
			now: 1,
		})
		const reply = store.addMessage({
			channel: 'c',
			author: 'b',
			body: 'r',
			parent: parent.id,
			now: 2,
		})
		expect(store.getMessage(parent.id)).toMatchObject({
			replyCount: 1,
			lastReplyAt: 2,
		})
		expect(store.history('c').messages.map((m) => m.id)).toEqual([parent.id])
		expect(store.thread('c', parent.id)?.replies.map((m) => m.id)).toEqual([
			reply.id,
		])
		expect(() =>
			store.addMessage({
				channel: 'c',
				author: 'a',
				body: 'nested',
				parent: reply.id,
				now: 3,
			}),
		).toThrow(ChatStoreError)
	})

	it('rejects replies whose parent is in another channel', () => {
		const store = createStore()
		const parent = store.addMessage({
			channel: 'a',
			author: 'u',
			body: 'p',
			now: 1,
		})
		expect(() =>
			store.addMessage({
				channel: 'b',
				author: 'u',
				body: 'r',
				parent: parent.id,
				now: 2,
			}),
		).toThrow(/not found/i)
		expect(store.thread('b', parent.id)).toBeNull()
	})

	it('toggles reactions and caps distinct emoji per message', () => {
		const store = createStore()
		const message = store.addMessage({
			channel: 'c',
			author: 'a',
			body: 'hi',
			now: 1,
		})
		expect(store.toggleReaction(message.id, 'u1', '👍', 2)).toEqual([
			{ emoji: '👍', userIds: ['u1'] },
		])
		expect(store.toggleReaction(message.id, 'u2', '👍', 3)[0]?.userIds).toEqual(
			['u1', 'u2'],
		)
		expect(store.toggleReaction(message.id, 'u1', '👍', 4)[0]?.userIds).toEqual(
			['u2'],
		)
		const emojis = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊']
		const more = ['😋', '😎', '😍', '😘', '🥰', '😗', '😙', '😚', '🙂', '🤗']
		// 👍 (still held by u2) + 19 more fills the cap of 20 distinct emoji.
		for (const emoji of [...emojis, ...more].slice(0, 19)) {
			store.toggleReaction(message.id, 'u3', emoji, 5)
		}
		expect(() => store.toggleReaction(message.id, 'u3', '🫠', 6)).toThrow(
			ChatStoreError,
		)
		// Joining an existing reaction is still allowed at the cap.
		expect(() => store.toggleReaction(message.id, 'u4', '👍', 7)).not.toThrow()
	})

	it('tracks unread per user and never counts your own messages', () => {
		const store = createStore()
		const m1 = store.addMessage({
			channel: 'c',
			author: 'a',
			body: '1',
			now: 1,
		})
		store.addMessage({ channel: 'c', author: 'b', body: '2', now: 2 })
		const m3 = store.addMessage({
			channel: 'c',
			author: 'a',
			body: '3',
			now: 3,
		})
		expect(store.unread(['c'], 'b')[0]).toMatchObject({ unread: 2 })
		expect(store.unread(['c'], 'a')[0]).toMatchObject({ unread: 1 })
		store.markRead('c', 'b', m1.id)
		expect(store.unread(['c'], 'b')[0]?.unread).toBe(1)
		// Marking read past the newest message clamps to it and never moves back.
		store.markRead('c', 'b', 9999)
		expect(store.unread(['c'], 'b')[0]).toMatchObject({
			unread: 0,
			lastReadId: m3.id,
		})
		store.markRead('c', 'b', 1)
		expect(store.unread(['c'], 'b')[0]?.lastReadId).toBe(m3.id)
	})

	it('soft-deletes: clears the body and reactions but keeps the thread', () => {
		const store = createStore()
		const parent = store.addMessage({
			channel: 'c',
			author: 'a',
			body: 'oops',
			now: 1,
		})
		store.addMessage({
			channel: 'c',
			author: 'b',
			body: 'reply',
			parent: parent.id,
			now: 2,
		})
		store.toggleReaction(parent.id, 'b', '👍', 3)
		const deleted = store.softDelete(parent.id, 4)
		expect(deleted).toMatchObject({
			deleted: true,
			body: '',
			reactions: [],
			replyCount: 1,
		})
		expect(store.unread(['c'], 'z')[0]?.unread).toBe(1)
	})

	it('deletes a channel and all its data', () => {
		const store = createStore()
		const message = store.addMessage({
			channel: 'x',
			author: 'a',
			body: 'a',
			now: 1,
		})
		store.toggleReaction(message.id, 'b', '👍', 2)
		store.markRead('x', 'b', message.id)
		store.addMessage({ channel: 'y', author: 'a', body: 'keep', now: 3 })
		store.deleteChannel('x')
		expect(store.history('x').messages).toEqual([])
		expect(store.unread(['x'], 'b')[0]).toMatchObject({
			latestId: 0,
			lastReadId: 0,
		})
		expect(store.history('y').messages).toHaveLength(1)
	})
})

describe('ChatEngine authorization', () => {
	it('lets audience members read and post, and fans out only to them', async () => {
		const h = createHarness({ eng: ['alice', 'bob'] })
		const alice = h.connect('alice')
		const bob = h.connect('bob')
		const mallory = h.connect('mallory')
		await h.send(alice, { t: 'send', id: '1', channel: 'eng', body: ' hello ' })

		expect(h.ack(alice, '1')).toMatchObject({ ok: true })
		const received = (conn: TestConn) =>
			conn.frames.filter((frame) => frame.t === 'message')
		expect(received(alice)).toHaveLength(1)
		expect(received(bob)).toHaveLength(1)
		expect(received(bob)[0]).toMatchObject({ message: { body: 'hello' } })
		expect(received(mallory)).toHaveLength(0)
		// Nothing about the channel leaks to the outsider.
		expect(JSON.stringify(mallory.frames)).not.toContain('hello')
	})

	it('denies outsiders every read and write path', async () => {
		const h = createHarness({ eng: ['alice'] })
		const alice = h.connect('alice')
		const mallory = h.connect('mallory')
		await h.send(alice, { t: 'send', id: 's', channel: 'eng', body: 'private' })
		const messageId = (
			h.ack(alice, 's') as { data: { message: { id: number } } }
		).data.message.id

		const attempts: Record<string, unknown>[] = [
			{ t: 'history', id: 'h', channel: 'eng' },
			{ t: 'thread', id: 't', channel: 'eng', parent: messageId },
			{ t: 'send', id: 'w', channel: 'eng', body: 'x' },
			{ t: 'read', id: 'r', channel: 'eng', upTo: messageId },
			{ t: 'edit', id: 'e', message: messageId, body: 'x' },
			{ t: 'delete', id: 'd', message: messageId },
			{ t: 'react', id: 'x', message: messageId, emoji: '👍' },
		]
		for (const attempt of attempts) {
			await h.send(mallory, attempt)
			expect(h.ack(mallory, attempt.id as string)).toMatchObject({
				ok: false,
				error: 'forbidden',
			})
		}
		expect(JSON.stringify(mallory.frames)).not.toContain('private')
		expect(h.store.history('eng').messages).toHaveLength(1)
	})

	it('treats unknown channels as forbidden, not as empty', async () => {
		const h = createHarness({})
		const alice = h.connect('alice')
		await h.send(alice, { t: 'history', id: '1', channel: 'nope' })
		expect(h.ack(alice, '1')).toMatchObject({ ok: false, error: 'forbidden' })
	})

	it('only returns unread counts for channels the user can access', async () => {
		const h = createHarness({ open: ['alice', 'bob'], hidden: ['bob'] })
		const alice = h.connect('alice')
		const bob = h.connect('bob')
		await h.send(bob, { t: 'send', id: '1', channel: 'open', body: 'hi' })
		await h.send(bob, { t: 'send', id: '2', channel: 'hidden', body: 'psst' })
		await h.send(alice, {
			t: 'sync',
			id: 'sync',
			channels: ['open', 'hidden', 'missing'],
		})
		const data = (
			h.ack(alice, 'sync') as { data: { channels: { channel: string }[] } }
		).data
		expect(data.channels.map((entry) => entry.channel)).toEqual(['open'])
	})

	it('stops honoring revoked access once the audience cache expires', async () => {
		const h = createHarness(
			{ eng: ['alice', 'bob'] },
			{ audienceTtlMs: 30_000 },
		)
		const alice = h.connect('alice')
		const bob = h.connect('bob')
		await h.send(alice, { t: 'history', id: '1', channel: 'eng' })
		expect(h.ack(alice, '1')).toMatchObject({ ok: true })

		h.audiences.set('eng', new Set(['bob']))
		h.advance(10_000)
		await h.send(alice, { t: 'history', id: '2', channel: 'eng' })
		expect(h.ack(alice, '2')).toMatchObject({ ok: true }) // still cached

		h.advance(25_000)
		await h.send(alice, { t: 'history', id: '3', channel: 'eng' })
		expect(h.ack(alice, '3')).toMatchObject({ ok: false, error: 'forbidden' })
		await h.send(bob, { t: 'history', id: '4', channel: 'eng' })
		expect(h.ack(bob, '4')).toMatchObject({ ok: true })
	})

	it('invalidate() applies access changes immediately', async () => {
		const h = createHarness({ eng: ['alice'] })
		const alice = h.connect('alice')
		await h.send(alice, { t: 'history', id: '1', channel: 'eng' })
		h.audiences.set('eng', new Set())
		h.engine.invalidate()
		await h.send(alice, { t: 'history', id: '2', channel: 'eng' })
		expect(h.ack(alice, '2')).toMatchObject({ ok: false, error: 'forbidden' })
	})

	it('resolves a batch of channels with a single lookup', async () => {
		const h = createHarness({ a: ['u'], b: ['u'], c: ['u'] })
		const conn = h.connect('u')
		await h.send(conn, { t: 'sync', id: '1', channels: ['a', 'b', 'c'] })
		expect(h.resolveCalls()).toBe(1)
	})

	it('evicts a removed user: closes every socket and revokes access', async () => {
		const h = createHarness({ eng: ['alice', 'bob'] })
		const tabOne = h.connect('bob')
		const tabTwo = h.connect('bob')
		const alice = h.connect('alice')
		h.engine.evictUser('bob')
		expect(tabOne.closed?.code).toBe(CHAT_CLOSE.forbidden)
		expect(tabTwo.closed?.code).toBe(CHAT_CLOSE.forbidden)
		expect(alice.closed).toBeNull()
		expect(alice.frames.at(-1)).toEqual({
			t: 'presence',
			user: 'bob',
			online: false,
		})
	})
})

describe('ChatEngine message rules', () => {
	it('lets authors edit but never lets anyone, even moderators, edit others', async () => {
		const h = createHarness({ eng: ['alice', 'bob', 'mod'] })
		const alice = h.connect('alice')
		const bob = h.connect('bob')
		const mod = h.connect('mod', true)
		await h.send(alice, { t: 'send', id: 's', channel: 'eng', body: 'v1' })
		const id = (h.ack(alice, 's') as { data: { message: { id: number } } }).data
			.message.id

		await h.send(alice, { t: 'edit', id: 'e1', message: id, body: 'v2' })
		expect(h.ack(alice, 'e1')).toMatchObject({ ok: true })
		expect(h.store.getMessage(id)).toMatchObject({ body: 'v2' })
		expect(h.store.getMessage(id)?.editedAt).not.toBeNull()
		expect(
			bob.frames.some(
				(frame) => frame.t === 'message.updated' && frame.message.body === 'v2',
			),
		).toBe(true)

		for (const [conn, requestId] of [
			[bob, 'e2'],
			[mod, 'e3'],
		] as const) {
			await h.send(conn, { t: 'edit', id: requestId, message: id, body: 'hax' })
			expect(h.ack(conn, requestId)).toMatchObject({
				ok: false,
				error: 'forbidden',
			})
		}
		expect(h.store.getMessage(id)?.body).toBe('v2')
	})

	it('lets authors and moderators delete, but not other members', async () => {
		const h = createHarness({ eng: ['alice', 'bob', 'mod'] })
		const alice = h.connect('alice')
		const bob = h.connect('bob')
		const mod = h.connect('mod', true)
		await h.send(alice, { t: 'send', id: 's1', channel: 'eng', body: 'one' })
		await h.send(alice, { t: 'send', id: 's2', channel: 'eng', body: 'two' })
		const [one, two] = ['s1', 's2'].map(
			(id) =>
				(h.ack(alice, id) as { data: { message: { id: number } } }).data.message
					.id,
		) as [number, number]

		await h.send(bob, { t: 'delete', id: 'd1', message: one })
		expect(h.ack(bob, 'd1')).toMatchObject({ ok: false, error: 'forbidden' })
		await h.send(mod, { t: 'delete', id: 'd2', message: one })
		expect(h.ack(mod, 'd2')).toMatchObject({ ok: true })
		await h.send(alice, { t: 'delete', id: 'd3', message: two })
		expect(h.ack(alice, 'd3')).toMatchObject({ ok: true })
		expect(h.store.getMessage(one)).toMatchObject({ deleted: true, body: '' })
		expect(
			bob.frames.filter((frame) => frame.t === 'message.deleted'),
		).toHaveLength(2)
	})

	it('re-checks moderation so a demoted moderator loses it without reconnecting', async () => {
		const moderators = new Set(['mod'])
		const h = createHarness(
			{ eng: ['alice', 'mod'] },
			{ isModerator: async (userId) => moderators.has(userId) },
		)
		const alice = h.connect('alice')
		// The socket was opened while `mod` was a moderator.
		const mod = h.connect('mod', true)
		await h.send(alice, { t: 'send', id: 's1', channel: 'eng', body: 'one' })
		await h.send(alice, { t: 'send', id: 's2', channel: 'eng', body: 'two' })
		const [one, two] = ['s1', 's2'].map(
			(id) =>
				(h.ack(alice, id) as { data: { message: { id: number } } }).data.message
					.id,
		) as [number, number]
		await h.send(mod, { t: 'delete', id: 'd1', message: one })
		expect(h.ack(mod, 'd1')).toMatchObject({ ok: true })

		moderators.delete('mod')
		h.engine.invalidate()
		await h.send(mod, { t: 'delete', id: 'd2', message: two })
		expect(h.ack(mod, 'd2')).toMatchObject({ ok: false, error: 'forbidden' })
		expect(h.store.getMessage(two)?.deleted).toBe(false)
	})

	it('a moderator cannot delete in a channel they cannot access', async () => {
		const h = createHarness({ secret: ['alice'] })
		const alice = h.connect('alice')
		const mod = h.connect('mod', true)
		await h.send(alice, { t: 'send', id: 's', channel: 'secret', body: 'x' })
		const id = (h.ack(alice, 's') as { data: { message: { id: number } } }).data
			.message.id
		await h.send(mod, { t: 'delete', id: 'd', message: id })
		expect(h.ack(mod, 'd')).toMatchObject({ ok: false, error: 'forbidden' })
		expect(h.store.getMessage(id)?.deleted).toBe(false)
	})

	it('broadcasts replies and an updated parent reply count', async () => {
		const h = createHarness({ eng: ['alice', 'bob'] })
		const alice = h.connect('alice')
		const bob = h.connect('bob')
		await h.send(alice, { t: 'send', id: 's', channel: 'eng', body: 'parent' })
		const parentId = (
			h.ack(alice, 's') as { data: { message: { id: number } } }
		).data.message.id
		await h.send(bob, {
			t: 'send',
			id: 'r',
			channel: 'eng',
			body: 'reply',
			parent: parentId,
		})
		expect(
			alice.frames.some(
				(frame) =>
					frame.t === 'message.updated' &&
					frame.message.id === parentId &&
					frame.message.replyCount === 1,
			),
		).toBe(true)
	})

	it('broadcasts reaction changes to the audience only', async () => {
		const h = createHarness({ eng: ['alice', 'bob'] })
		const alice = h.connect('alice')
		const bob = h.connect('bob')
		const outsider = h.connect('outsider')
		await h.send(alice, { t: 'send', id: 's', channel: 'eng', body: 'hi' })
		const id = (h.ack(alice, 's') as { data: { message: { id: number } } }).data
			.message.id
		await h.send(bob, { t: 'react', id: 'r', message: id, emoji: '🎉' })
		const reactionFrame = alice.frames.find((frame) => frame.t === 'reactions')
		expect(reactionFrame).toMatchObject({
			message: id,
			reactions: [{ emoji: '🎉', userIds: ['bob'] }],
		})
		expect(outsider.frames.some((frame) => frame.t === 'reactions')).toBe(false)
	})

	it('rejects non-emoji reactions at the protocol boundary', async () => {
		const h = createHarness({ eng: ['alice'] })
		const alice = h.connect('alice')
		await h.send(alice, { t: 'send', id: 's', channel: 'eng', body: 'hi' })
		const id = (h.ack(alice, 's') as { data: { message: { id: number } } }).data
			.message.id
		await h.send(alice, { t: 'react', id: 'r', message: id, emoji: 'lol' })
		expect(h.ack(alice, 'r')).toMatchObject({ ok: false, error: 'bad_request' })
	})

	it('rate limits floods of mutations per user', async () => {
		const h = createHarness({ eng: ['alice'] })
		const alice = h.connect('alice')
		for (let index = 0; index < 32; index++) {
			await h.send(alice, {
				t: 'send',
				id: `s${index}`,
				channel: 'eng',
				body: 'spam',
			})
		}
		expect(h.ack(alice, 's29')).toMatchObject({ ok: true })
		expect(h.ack(alice, 's30')).toMatchObject({
			ok: false,
			error: 'rate_limited',
		})
		h.advance(11_000)
		await h.send(alice, { t: 'send', id: 'later', channel: 'eng', body: 'ok' })
		expect(h.ack(alice, 'later')).toMatchObject({ ok: true })
	})

	it('shows typing to others in the channel, throttled', async () => {
		const h = createHarness({ eng: ['alice', 'bob'] })
		const alice = h.connect('alice')
		const bob = h.connect('bob')
		const outsider = h.connect('outsider')
		await h.send(alice, { t: 'typing', channel: 'eng' })
		await h.send(alice, { t: 'typing', channel: 'eng' })
		expect(bob.frames.filter((frame) => frame.t === 'typing')).toHaveLength(1)
		expect(alice.frames.some((frame) => frame.t === 'typing')).toBe(false)
		expect(outsider.frames.some((frame) => frame.t === 'typing')).toBe(false)
		h.advance(2_500)
		await h.send(alice, { t: 'typing', channel: 'eng' })
		expect(bob.frames.filter((frame) => frame.t === 'typing')).toHaveLength(2)
	})
})

describe('ChatEngine protocol hygiene', () => {
	it('answers invalid frames with a bad_request ack when an id is present', async () => {
		const h = createHarness({ eng: ['alice'] })
		const alice = h.connect('alice')
		await h.send(alice, { t: 'send', id: 'bad', channel: 'eng', body: '' })
		expect(h.ack(alice, 'bad')).toMatchObject({
			ok: false,
			error: 'bad_request',
		})
		await h.send(alice, {
			t: 'send',
			id: 'long',
			channel: 'eng',
			body: 'x'.repeat(CHAT_LIMITS.bodyMax + 1),
		})
		expect(h.ack(alice, 'long')).toMatchObject({
			ok: false,
			error: 'bad_request',
		})
	})

	it('ignores garbage and closes oversized frames', async () => {
		const h = createHarness({ eng: ['alice'] })
		const alice = h.connect('alice')
		await h.engine.handle(alice, 'not json')
		await h.engine.handle(alice, new ArrayBuffer(4))
		expect(alice.closed).toBeNull()
		await h.engine.handle(alice, 'x'.repeat(CHAT_LIMITS.frameBytesMax + 1))
		expect(alice.closed?.code).toBe(CHAT_CLOSE.tooLarge)
	})

	it('announces presence only for a first connection and a last disconnect', async () => {
		const h = createHarness({})
		const watcher = h.connect('watcher')
		const first = h.connect('bob')
		expect(watcher.frames.filter((frame) => frame.t === 'presence')).toEqual([
			{ t: 'presence', user: 'bob', online: true },
		])
		const second = h.connect('bob')
		expect(
			watcher.frames.filter((frame) => frame.t === 'presence'),
		).toHaveLength(1)
		first.closed = { code: 1000, reason: '' }
		h.engine.close(first)
		expect(
			watcher.frames.filter((frame) => frame.t === 'presence'),
		).toHaveLength(1)
		second.closed = { code: 1000, reason: '' }
		h.engine.close(second)
		expect(watcher.frames.at(-1)).toEqual({
			t: 'presence',
			user: 'bob',
			online: false,
		})
	})

	it('caps simultaneous connections per user', () => {
		const h = createHarness({})
		const tabs = Array.from({ length: 9 }, () => h.connect('bob'))
		expect(tabs[8]!.closed?.code).toBe(CHAT_CLOSE.tooManyConnections)
		expect(tabs[7]!.closed).toBeNull()
	})

	it('deleteChannel wipes data and notifies connections', () => {
		const h = createHarness({ eng: ['alice'] })
		const alice = h.connect('alice')
		h.store.addMessage({ channel: 'eng', author: 'alice', body: 'x', now: 1 })
		h.engine.deleteChannel('eng')
		expect(h.store.history('eng').messages).toEqual([])
		expect(alice.frames.at(-1)).toEqual({
			t: 'channel.deleted',
			channel: 'eng',
		})
	})
})
