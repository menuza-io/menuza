import {
	CHAT_LIMITS,
	chatClientFrameSchema,
	type ChatClientFrame,
	type ChatErrorCode,
	type ChatMessage,
	type ChatPerson,
	type ChatServerFrame,
} from '@repo/common/chat'
import { ChatStoreError, type ChatStore } from './chat-store.ts'

/** WebSocket close codes (4xxx is application-defined). */
export const CHAT_CLOSE = {
	tooLarge: 1009,
	forbidden: 4403,
	tooManyConnections: 4429,
} as const

export type ChatConnection = {
	/** Unique per socket. */
	id: string
	userId: string
	/** Holds `update:chat:any`; may remove other people's messages. */
	canModerate: boolean
	send(frame: string): void
	close(code: number, reason: string): void
}

export type ChatEngineDeps = {
	store: ChatStore
	/**
	 * Authoritative audience (user ids allowed to read and post) for each
	 * requested channel, resolved from the control-plane database. Channels that
	 * do not exist resolve to an empty set. Must batch: the engine calls it with
	 * every channel it needs in one go.
	 */
	resolveAudiences(channelIds: string[]): Promise<Map<string, Set<string>>>
	/**
	 * Whether the user currently holds `update:chat:any`. Optional: without it
	 * the flag captured when the socket opened is used. In production this is
	 * re-checked (cached for `audienceTtlMs`) so a demoted moderator loses the
	 * power to delete others' messages without having to reconnect.
	 */
	isModerator?(userId: string): Promise<boolean>
	/** All live sockets for this organization. */
	connections(): ChatConnection[]
	now?: () => number
	/** How long a resolved audience is trusted. Bounds revocation latency. */
	audienceTtlMs?: number
	/** Hide messages before this timestamp for late joiners (ms since epoch). */
	historyCutoff?: (userId: string, channelId: string) => Promise<number | null>
	/** Fire-and-forget hook after a message is persisted (notifications, etc.). */
	onMessageSent?: (input: {
		message: ChatMessage
		authorId: string
	}) => void | Promise<void>
}

const MAX_CONNECTIONS_PER_USER = 8
const MUTATION_LIMIT = { windowMs: 10_000, max: 30 }
const READ_LIMIT = { windowMs: 10_000, max: 120 }
const TYPING_MIN_INTERVAL_MS = 2_000

type AudienceEntry = { users: Set<string>; at: number }
type ModeratorEntry = { value: boolean; at: number }

export class ChatEngine {
	private readonly audiences = new Map<string, AudienceEntry>()
	private readonly mutationWindows = new Map<
		string,
		{ start: number; count: number }
	>()
	private readonly readWindows = new Map<
		string,
		{ start: number; count: number }
	>()
	private readonly lastTyping = new Map<string, number>()
	private readonly moderators = new Map<string, ModeratorEntry>()
	private readonly store: ChatStore
	private readonly now: () => number
	private readonly audienceTtlMs: number

	constructor(private readonly deps: ChatEngineDeps) {
		this.store = deps.store
		this.now = deps.now ?? Date.now
		this.audienceTtlMs = deps.audienceTtlMs ?? 30_000
	}

	// ── connection lifecycle ───────────────────────────────────────────────

	open(conn: ChatConnection, person: ChatPerson) {
		const others = this.deps
			.connections()
			.filter((other) => other.userId === conn.userId && other.id !== conn.id)
		if (others.length >= MAX_CONNECTIONS_PER_USER) {
			conn.close(CHAT_CLOSE.tooManyConnections, 'Too many open chat tabs')
			return
		}
		this.store.upsertPerson(person, this.now())
		this.sendTo(conn, {
			t: 'ready',
			me: { id: conn.userId, canModerate: conn.canModerate },
			online: this.onlineUserIds(),
		})
		if (others.length === 0) {
			this.broadcastAll(
				{ t: 'presence', user: conn.userId, online: true },
				conn,
			)
		}
	}

	close(conn: ChatConnection) {
		const stillConnected = this.deps
			.connections()
			.some((other) => other.userId === conn.userId && other.id !== conn.id)
		if (!stillConnected) {
			this.broadcastAll(
				{ t: 'presence', user: conn.userId, online: false },
				conn,
			)
		}
	}

	// ── inbound frames ─────────────────────────────────────────────────────

	async handle(conn: ChatConnection, raw: string | ArrayBuffer) {
		if (typeof raw !== 'string') {
			this.sendTo(conn, this.fail('', 'bad_request', 'Unsupported message.'))
			return
		}
		if (raw.length > CHAT_LIMITS.frameBytesMax) {
			conn.close(CHAT_CLOSE.tooLarge, 'Message too large')
			return
		}
		let json: unknown
		try {
			json = JSON.parse(raw)
		} catch {
			this.sendTo(conn, this.fail('', 'bad_request', 'Malformed message.'))
			return
		}
		const parsed = chatClientFrameSchema.safeParse(json)
		if (!parsed.success) {
			const id =
				typeof (json as { id?: unknown })?.id === 'string'
					? (json as { id: string }).id.slice(0, 64)
					: ''
			if (id) {
				this.sendTo(
					conn,
					this.fail(
						id,
						'bad_request',
						parsed.error.issues[0]?.message ?? 'Invalid request.',
					),
				)
			}
			return
		}
		const frame = parsed.data
		try {
			await this.dispatch(conn, frame)
		} catch (error) {
			if (error instanceof ChatStoreError) {
				if ('id' in frame) {
					this.sendTo(conn, this.fail(frame.id, error.code, error.message))
				}
				return
			}
			console.error('Chat frame failed', error)
			if ('id' in frame) {
				this.sendTo(
					conn,
					this.fail(frame.id, 'internal', 'Something went wrong. Try again.'),
				)
			}
		}
	}

	private async dispatch(conn: ChatConnection, frame: ChatClientFrame) {
		switch (frame.t) {
			case 'ping':
				this.sendTo(conn, { t: 'pong' })
				return
			case 'typing':
				return this.onTyping(conn, frame.channel)
			case 'sync':
				if (this.readRateLimited(conn.userId)) {
					return this.sendTo(
						conn,
						this.fail(
							frame.id,
							'rate_limited',
							'You are requesting data too fast.',
						),
					)
				}
				return this.onSync(conn, frame.id, frame.channels)
			case 'history':
				if (this.readRateLimited(conn.userId)) {
					return this.sendTo(
						conn,
						this.fail(
							frame.id,
							'rate_limited',
							'You are requesting data too fast.',
						),
					)
				}
				return this.onHistory(conn, frame)
			case 'search':
				if (this.readRateLimited(conn.userId)) {
					return this.sendTo(
						conn,
						this.fail(
							frame.id,
							'rate_limited',
							'You are requesting data too fast.',
						),
					)
				}
				return this.onSearch(conn, frame)
			case 'thread':
				if (this.readRateLimited(conn.userId)) {
					return this.sendTo(
						conn,
						this.fail(
							frame.id,
							'rate_limited',
							'You are requesting data too fast.',
						),
					)
				}
				return this.onThread(conn, frame)
			case 'read':
				if (this.readRateLimited(conn.userId)) {
					return this.sendTo(
						conn,
						this.fail(
							frame.id,
							'rate_limited',
							'You are requesting data too fast.',
						),
					)
				}
				return this.onRead(conn, frame)
			case 'send':
			case 'edit':
			case 'delete':
			case 'react': {
				if (this.rateLimited(conn.userId)) {
					this.sendTo(
						conn,
						this.fail(frame.id, 'rate_limited', 'You are sending too fast.'),
					)
					return
				}
				if (frame.t === 'send') return this.onSend(conn, frame)
				if (frame.t === 'edit') return this.onEdit(conn, frame)
				if (frame.t === 'delete') return this.onDelete(conn, frame)
				return this.onReact(conn, frame)
			}
		}
	}

	private async onSync(conn: ChatConnection, id: string, channels: string[]) {
		const allowed = await this.allowedChannels(conn.userId, channels)
		this.sendTo(conn, {
			t: 'ack',
			id,
			ok: true,
			data: { channels: this.store.unread(allowed, conn.userId) },
		})
	}

	private async onHistory(
		conn: ChatConnection,
		frame: Extract<ChatClientFrame, { t: 'history' }>,
	) {
		if (!(await this.canAccess(conn, frame.channel))) {
			return this.deny(conn, frame.id)
		}
		const since =
			(await this.deps.historyCutoff?.(conn.userId, frame.channel)) ?? undefined
		this.ack(
			conn,
			frame.id,
			this.store.history(frame.channel, {
				before: frame.before,
				limit: frame.limit,
				since,
			}),
		)
	}

	private async onThread(
		conn: ChatConnection,
		frame: Extract<ChatClientFrame, { t: 'thread' }>,
	) {
		if (!(await this.canAccess(conn, frame.channel))) {
			return this.deny(conn, frame.id)
		}
		const since =
			(await this.deps.historyCutoff?.(conn.userId, frame.channel)) ?? undefined
		const thread = this.store.thread(frame.channel, frame.parent, {
			before: frame.before,
			limit: frame.limit,
			since,
		})
		if (!thread) {
			this.sendTo(
				conn,
				this.fail(frame.id, 'not_found', 'The message was not found.'),
			)
			return
		}
		this.ack(conn, frame.id, thread)
	}

	private async onRead(
		conn: ChatConnection,
		frame: Extract<ChatClientFrame, { t: 'read' }>,
	) {
		if (!(await this.canAccess(conn, frame.channel))) {
			return this.deny(conn, frame.id)
		}
		this.store.markRead(frame.channel, conn.userId, frame.upTo)
		this.ack(conn, frame.id, {})
	}

	private async onSend(
		conn: ChatConnection,
		frame: Extract<ChatClientFrame, { t: 'send' }>,
	) {
		if (!(await this.canAccess(conn, frame.channel))) {
			return this.deny(conn, frame.id)
		}
		const body = frame.body.trim()
		const attachmentKeys = frame.attachmentKeys ?? []
		if (!body && attachmentKeys.length === 0) {
			this.sendTo(
				conn,
				this.fail(frame.id, 'bad_request', 'Write a message first.'),
			)
			return
		}
		if (attachmentKeys.length > CHAT_LIMITS.attachmentsMax) {
			this.sendTo(
				conn,
				this.fail(frame.id, 'bad_request', 'Too many attachments.'),
			)
			return
		}
		const message = this.store.addMessage({
			channel: frame.channel,
			author: conn.userId,
			body,
			attachmentKeys,
			parent: frame.parent,
			now: this.now(),
		})
		// Sending counts as having read everything up to your own message.
		this.store.markRead(frame.channel, conn.userId, message.id)
		this.ack(conn, frame.id, { message })
		const people = this.store.getPeople([message.author])
		await this.broadcast(frame.channel, { t: 'message', message, people })
		if (message.parent !== null) {
			const parent = this.store.getMessage(message.parent)
			if (parent) {
				await this.broadcast(frame.channel, {
					t: 'message.updated',
					message: parent,
				})
			}
		}
		void this.deps.onMessageSent?.({ message, authorId: conn.userId })
	}

	private async onSearch(
		conn: ChatConnection,
		frame: Extract<ChatClientFrame, { t: 'search' }>,
	) {
		const allowed = await this.allowedChannels(conn.userId, frame.channels)
		const hits = this.store.search(frame.query, {
			limit: frame.limit,
			channelIds: allowed,
		})
		const allowedSet = new Set(allowed)
		const visible = hits.filter((hit) => allowedSet.has(hit.channel))
		const people = this.store.getPeople([
			...new Set(visible.map((hit) => hit.author)),
		])
		this.ack(conn, frame.id, { results: visible, people })
	}

	private async onEdit(
		conn: ChatConnection,
		frame: Extract<ChatClientFrame, { t: 'edit' }>,
	) {
		const existing = this.store.getMessage(frame.message)
		if (!existing || existing.deleted) {
			return this.sendTo(
				conn,
				this.fail(frame.id, 'not_found', 'The message was not found.'),
			)
		}
		if (!(await this.canAccess(conn, existing.channel))) {
			return this.deny(conn, frame.id)
		}
		// Moderators can remove messages but never rewrite what someone said.
		if (existing.author !== conn.userId) {
			return this.sendTo(
				conn,
				this.fail(
					frame.id,
					'forbidden',
					'You can only edit your own messages.',
				),
			)
		}
		const message = this.store.updateBody(
			existing.id,
			frame.body.trim(),
			this.now(),
		)
		if (!message) return
		this.ack(conn, frame.id, { message })
		await this.broadcast(message.channel, { t: 'message.updated', message })
	}

	private async onDelete(
		conn: ChatConnection,
		frame: Extract<ChatClientFrame, { t: 'delete' }>,
	) {
		const existing = this.store.getMessage(frame.message)
		if (!existing || existing.deleted) {
			return this.sendTo(
				conn,
				this.fail(frame.id, 'not_found', 'The message was not found.'),
			)
		}
		if (!(await this.canAccess(conn, existing.channel))) {
			return this.deny(conn, frame.id)
		}
		if (existing.author !== conn.userId && !(await this.isModerator(conn))) {
			return this.sendTo(
				conn,
				this.fail(
					frame.id,
					'forbidden',
					'You can only delete your own messages.',
				),
			)
		}
		this.store.softDelete(existing.id, this.now())
		this.ack(conn, frame.id, {})
		await this.broadcast(existing.channel, {
			t: 'message.deleted',
			channel: existing.channel,
			id: existing.id,
			parent: existing.parent,
		})
		if (existing.parent !== null) {
			const parent = this.store.getMessage(existing.parent)
			if (parent) {
				await this.broadcast(existing.channel, {
					t: 'message.updated',
					message: parent,
				})
			}
		}
	}

	private async onReact(
		conn: ChatConnection,
		frame: Extract<ChatClientFrame, { t: 'react' }>,
	) {
		const existing = this.store.getMessage(frame.message)
		if (!existing) {
			return this.sendTo(
				conn,
				this.fail(frame.id, 'not_found', 'The message was not found.'),
			)
		}
		if (!(await this.canAccess(conn, existing.channel))) {
			return this.deny(conn, frame.id)
		}
		if (existing.deleted) {
			return this.sendTo(
				conn,
				this.fail(frame.id, 'conflict', 'This message was deleted.'),
			)
		}
		const reactions = this.store.toggleReaction(
			existing.id,
			conn.userId,
			frame.emoji,
			this.now(),
		)
		this.ack(conn, frame.id, {})
		await this.broadcast(existing.channel, {
			t: 'reactions',
			channel: existing.channel,
			message: existing.id,
			reactions,
		})
	}

	private async onTyping(conn: ChatConnection, channel: string) {
		const key = `${conn.userId}:${channel}`
		const now = this.now()
		if (now - (this.lastTyping.get(key) ?? 0) < TYPING_MIN_INTERVAL_MS) return
		if (!(await this.canAccess(conn, channel))) return
		this.lastTyping.set(key, now)
		if (this.lastTyping.size > 2000) this.pruneTyping(now)
		await this.broadcast(
			channel,
			{ t: 'typing', channel, user: conn.userId },
			conn.id,
		)
	}

	// ── control calls from the Worker ──────────────────────────────────────

	/** A member was removed or deactivated: drop their sockets immediately. */
	evictUser(userId: string) {
		for (const conn of this.deps.connections()) {
			if (conn.userId === userId) {
				conn.close(CHAT_CLOSE.forbidden, 'Access revoked')
			}
		}
		this.audiences.clear()
		this.moderators.clear()
		this.broadcastAll({ t: 'presence', user: userId, online: false })
	}

	/** Channel rules or membership changed: re-resolve audiences on next use. */
	invalidate() {
		this.audiences.clear()
		this.moderators.clear()
	}

	channelsChanged() {
		this.audiences.clear()
		this.broadcastAll({ t: 'channels.changed' })
	}

	deleteChannel(channelId: string) {
		this.store.deleteChannel(channelId)
		this.audiences.delete(channelId)
		this.broadcastAll({ t: 'channel.deleted', channel: channelId })
	}

	// ── authorization ──────────────────────────────────────────────────────

	private async isModerator(conn: ChatConnection) {
		const lookup = this.deps.isModerator
		if (!lookup) return conn.canModerate
		const now = this.now()
		const cached = this.moderators.get(conn.userId)
		if (cached && now - cached.at <= this.audienceTtlMs) return cached.value
		const value = await lookup(conn.userId)
		this.moderators.set(conn.userId, { value, at: now })
		return value
	}

	private async audiencesFor(channelIds: string[]) {
		const now = this.now()
		const missing = [...new Set(channelIds)].filter((id) => {
			const entry = this.audiences.get(id)
			return !entry || now - entry.at > this.audienceTtlMs
		})
		if (missing.length > 0) {
			const resolved = await this.deps.resolveAudiences(missing)
			for (const id of missing) {
				this.audiences.set(id, {
					users: resolved.get(id) ?? new Set(),
					at: now,
				})
			}
		}
		return (id: string) => this.audiences.get(id)?.users ?? new Set<string>()
	}

	private async canAccess(conn: ChatConnection, channelId: string) {
		const audience = await this.audiencesFor([channelId])
		return audience(channelId).has(conn.userId)
	}

	private async allowedChannels(userId: string, channelIds: string[]) {
		const audience = await this.audiencesFor(channelIds)
		return channelIds.filter((id) => audience(id).has(userId))
	}

	// ── sending ────────────────────────────────────────────────────────────

	private async broadcast(
		channelId: string,
		frame: ChatServerFrame,
		exceptConnectionId?: string,
	) {
		const audience = (await this.audiencesFor([channelId]))(channelId)
		const payload = JSON.stringify(frame)
		for (const conn of this.deps.connections()) {
			if (conn.id === exceptConnectionId) continue
			if (audience.has(conn.userId)) this.safeSend(conn, payload)
		}
	}

	private broadcastAll(frame: ChatServerFrame, except?: ChatConnection) {
		const payload = JSON.stringify(frame)
		for (const conn of this.deps.connections()) {
			if (conn.id !== except?.id) this.safeSend(conn, payload)
		}
	}

	private sendTo(conn: ChatConnection, frame: ChatServerFrame) {
		this.safeSend(conn, JSON.stringify(frame))
	}

	private safeSend(conn: ChatConnection, payload: string) {
		try {
			conn.send(payload)
		} catch {
			// The socket is closing; its close handler cleans up.
		}
	}

	private ack(conn: ChatConnection, id: string, data: unknown) {
		this.sendTo(conn, { t: 'ack', id, ok: true, data })
	}

	private deny(conn: ChatConnection, id: string) {
		this.sendTo(
			conn,
			this.fail(id, 'forbidden', 'You do not have access to this channel.'),
		)
	}

	private fail(
		id: string,
		error: ChatErrorCode,
		message: string,
	): ChatServerFrame {
		return { t: 'ack', id, ok: false, error, message }
	}

	private onlineUserIds() {
		return [...new Set(this.deps.connections().map((conn) => conn.userId))]
	}

	private rateLimited(userId: string) {
		return this.inWindow(
			this.mutationWindows,
			userId,
			MUTATION_LIMIT.windowMs,
			MUTATION_LIMIT.max,
		)
	}

	private readRateLimited(userId: string) {
		return this.inWindow(
			this.readWindows,
			userId,
			READ_LIMIT.windowMs,
			READ_LIMIT.max,
		)
	}

	private inWindow(
		windows: Map<string, { start: number; count: number }>,
		userId: string,
		windowMs: number,
		max: number,
	) {
		const now = this.now()
		const window = windows.get(userId)
		if (!window || now - window.start > windowMs) {
			windows.set(userId, { start: now, count: 1 })
			if (windows.size > 2000) {
				for (const [key, value] of windows) {
					if (now - value.start > windowMs) windows.delete(key)
				}
			}
			return false
		}
		window.count += 1
		return window.count > max
	}

	private pruneTyping(now: number) {
		for (const [key, at] of this.lastTyping) {
			if (now - at > TYPING_MIN_INTERVAL_MS) this.lastTyping.delete(key)
		}
	}
}
