import {
	CHAT_LIMITS,
	type ChatHistoryResult,
	type ChatMessage,
	type ChatPerson,
	type ChatReaction,
	type ChatUnread,
} from '@repo/common/chat'

/**
 * The slice of Durable Object SQLite (`ctx.storage.sql`) the store needs. Kept
 * structural so unit tests can back it with `node:sqlite`.
 */
export type ChatSql = {
	exec: (
		query: string,
		...bindings: unknown[]
	) => { toArray(): Record<string, unknown>[] }
}

export class ChatStoreError extends Error {
	constructor(
		readonly code: 'not_found' | 'conflict',
		message: string,
	) {
		super(message)
		this.name = 'ChatStoreError'
	}
}

type MessageRow = {
	id: number
	channel_id: string
	parent_id: number | null
	author_id: string
	body: string
	created_at: number
	edited_at: number | null
	deleted_at: number | null
}

/** Durable Object SQL allows at most 100 bound parameters per statement. */
const BIND_CHUNK = 90

function chunk<T>(values: T[], size = BIND_CHUNK) {
	const chunks: T[][] = []
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size))
	}
	return chunks
}

const placeholders = (count: number) => new Array(count).fill('?').join(',')

export class ChatStore {
	constructor(private readonly sql: ChatSql) {}

	private all<T>(query: string, ...bindings: unknown[]) {
		return this.sql.exec(query, ...bindings).toArray() as T[]
	}

	private run(query: string, ...bindings: unknown[]) {
		this.sql.exec(query, ...bindings).toArray()
	}

	migrate() {
		this.run(
			`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		)
		this.run(
			`CREATE TABLE IF NOT EXISTS people (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				image TEXT,
				updated_at INTEGER NOT NULL
			)`,
		)
		this.run(
			`CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				channel_id TEXT NOT NULL,
				parent_id INTEGER,
				author_id TEXT NOT NULL,
				body TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				edited_at INTEGER,
				deleted_at INTEGER
			)`,
		)
		this.run(
			`CREATE INDEX IF NOT EXISTS messages_channel_top
				ON messages (channel_id, id) WHERE parent_id IS NULL`,
		)
		this.run(
			`CREATE INDEX IF NOT EXISTS messages_channel_all ON messages (channel_id, id)`,
		)
		this.run(
			`CREATE INDEX IF NOT EXISTS messages_parent
				ON messages (parent_id, id) WHERE parent_id IS NOT NULL`,
		)
		this.run(
			`CREATE TABLE IF NOT EXISTS reactions (
				message_id INTEGER NOT NULL,
				user_id TEXT NOT NULL,
				emoji TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (message_id, user_id, emoji)
			)`,
		)
		this.run(
			`CREATE TABLE IF NOT EXISTS reads (
				channel_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				last_read_id INTEGER NOT NULL,
				PRIMARY KEY (channel_id, user_id)
			)`,
		)
		this.run(
			`CREATE TABLE IF NOT EXISTS message_attachments (
				message_id INTEGER NOT NULL,
				sort_order INTEGER NOT NULL,
				object_key TEXT NOT NULL,
				PRIMARY KEY (message_id, sort_order)
			)`,
		)
		this.run(
			`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
				body,
				content='messages',
				content_rowid='id'
			)`,
		)
		this.run(
			`CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
				INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
			END`,
		)
		this.run(
			`CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
				INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.id, old.body);
			END`,
		)
		this.run(
			`CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF body ON messages BEGIN
				INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.id, old.body);
				INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
			END`,
		)
		const ftsCount = this.all<{ c: number }>(
			`SELECT COUNT(*) AS c FROM messages_fts`,
		)[0]?.c
		if (ftsCount === 0) {
			this.run(
				`INSERT INTO messages_fts(rowid, body)
					SELECT id, body FROM messages WHERE deleted_at IS NULL`,
			)
		}
	}

	getMeta(key: string) {
		return (
			this.all<{ value: string }>(
				`SELECT value FROM meta WHERE key = ?`,
				key,
			)[0]?.value ?? null
		)
	}

	setMeta(key: string, value: string) {
		this.run(
			`INSERT INTO meta (key, value) VALUES (?, ?)
				ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
			key,
			value,
		)
	}

	upsertPerson(person: ChatPerson, now: number) {
		this.run(
			`INSERT INTO people (id, name, image, updated_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET
					name = excluded.name,
					image = excluded.image,
					updated_at = excluded.updated_at`,
			person.id,
			person.name,
			person.image,
			now,
		)
	}

	getPeople(ids: string[]): ChatPerson[] {
		const unique = [...new Set(ids)]
		return chunk(unique).flatMap((part) =>
			this.all<ChatPerson>(
				`SELECT id, name, image FROM people WHERE id IN (${placeholders(part.length)})`,
				...part,
			),
		)
	}

	private hydrate(rows: MessageRow[]): ChatMessage[] {
		if (rows.length === 0) return []
		const ids = rows.map((row) => row.id)
		const replies = new Map<number, { count: number; last: number | null }>()
		const reactions = new Map<number, Map<string, string[]>>()
		const attachments = new Map<number, { objectKey: string }[]>()

		for (const part of chunk(ids)) {
			for (const row of this.all<{
				parent_id: number
				count: number
				last: number | null
			}>(
				`SELECT parent_id, COUNT(*) AS count, MAX(created_at) AS last
					FROM messages
					WHERE parent_id IN (${placeholders(part.length)}) AND deleted_at IS NULL
					GROUP BY parent_id`,
				...part,
			)) {
				replies.set(row.parent_id, { count: row.count, last: row.last })
			}
			for (const row of this.all<{
				message_id: number
				emoji: string
				user_id: string
			}>(
				`SELECT message_id, emoji, user_id FROM reactions
					WHERE message_id IN (${placeholders(part.length)})
					ORDER BY created_at, rowid`,
				...part,
			)) {
				const byEmoji =
					reactions.get(row.message_id) ?? new Map<string, string[]>()
				byEmoji.set(row.emoji, [...(byEmoji.get(row.emoji) ?? []), row.user_id])
				reactions.set(row.message_id, byEmoji)
			}
			for (const row of this.all<{
				message_id: number
				object_key: string
			}>(
				`SELECT message_id, object_key FROM message_attachments
					WHERE message_id IN (${placeholders(part.length)})
					ORDER BY sort_order`,
				...part,
			)) {
				const list = attachments.get(row.message_id) ?? []
				list.push({ objectKey: row.object_key })
				attachments.set(row.message_id, list)
			}
		}

		return rows.map((row) => {
			const thread = replies.get(row.id)
			const byEmoji = reactions.get(row.id)
			return {
				id: row.id,
				channel: row.channel_id,
				parent: row.parent_id,
				author: row.author_id,
				body: row.deleted_at === null ? row.body : '',
				attachments:
					row.deleted_at === null ? (attachments.get(row.id) ?? []) : [],
				createdAt: row.created_at,
				editedAt: row.edited_at,
				deleted: row.deleted_at !== null,
				replyCount: thread?.count ?? 0,
				lastReplyAt: thread?.last ?? null,
				reactions: byEmoji
					? [...byEmoji].map(([emoji, userIds]) => ({ emoji, userIds }))
					: [],
			}
		})
	}

	getMessage(id: number): ChatMessage | null {
		const [row] = this.all<MessageRow>(
			`SELECT * FROM messages WHERE id = ?`,
			id,
		)
		return row ? (this.hydrate([row])[0] ?? null) : null
	}

	addMessage(input: {
		channel: string
		author: string
		body: string
		attachmentKeys?: string[]
		parent?: number
		now: number
	}): ChatMessage {
		if (input.parent !== undefined) {
			const parent = this.getMessage(input.parent)
			if (!parent || parent.channel !== input.channel) {
				throw new ChatStoreError('not_found', 'The message was not found.')
			}
			if (parent.parent !== null) {
				throw new ChatStoreError(
					'conflict',
					'Replies can only be added to top-level messages.',
				)
			}
			if (parent.deleted) {
				throw new ChatStoreError(
					'conflict',
					'You cannot reply to a deleted message.',
				)
			}
		}
		const keys = (input.attachmentKeys ?? []).slice(
			0,
			CHAT_LIMITS.attachmentsMax,
		)
		const [{ id }] = this.all<{ id: number }>(
			`INSERT INTO messages (channel_id, parent_id, author_id, body, created_at)
				VALUES (?, ?, ?, ?, ?) RETURNING id`,
			input.channel,
			input.parent ?? null,
			input.author,
			input.body,
			input.now,
		) as [{ id: number }]
		for (const [index, objectKey] of keys.entries()) {
			this.run(
				`INSERT INTO message_attachments (message_id, sort_order, object_key)
					VALUES (?, ?, ?)`,
				id,
				index,
				objectKey,
			)
		}
		return this.getMessage(id)!
	}

	search(
		query: string,
		options: { limit?: number; channelIds?: string[] } = {},
	) {
		const limit = Math.min(options.limit ?? 25, CHAT_LIMITS.searchResultsMax)
		const term = query
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map((word) => `"${word.replace(/"/g, '')}"`)
			.join(' ')
		if (!term) return []
		const channels = options.channelIds ?? []
		if (channels.length === 0) return []
		const rows: {
			id: number
			channel_id: string
			body: string
			created_at: number
			author_id: string
		}[] = []
		for (const part of chunk(channels)) {
			const channelClause = ` AND m.channel_id IN (${placeholders(part.length)})`
			rows.push(
				...this.all<{
					id: number
					channel_id: string
					body: string
					created_at: number
					author_id: string
				}>(
					`SELECT m.id, m.channel_id, m.body, m.created_at, m.author_id
						FROM messages_fts fts
						INNER JOIN messages m ON m.id = fts.rowid
						WHERE messages_fts MATCH ? AND m.deleted_at IS NULL${channelClause}
						ORDER BY m.id DESC
						LIMIT ?`,
					term,
					...part,
					limit,
				),
			)
		}
		rows.sort((a, b) => b.id - a.id)
		return rows.slice(0, limit).map((row) => ({
			id: row.id,
			channel: row.channel_id,
			body: row.body,
			createdAt: row.created_at,
			author: row.author_id,
		}))
	}

	updateBody(id: number, body: string, now: number) {
		this.run(
			`UPDATE messages SET body = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL`,
			body,
			now,
			id,
		)
		return this.getMessage(id)
	}

	softDelete(id: number, now: number) {
		this.run(
			`UPDATE messages SET body = '', deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
			now,
			id,
		)
		this.run(`DELETE FROM reactions WHERE message_id = ?`, id)
		return this.getMessage(id)
	}

	history(
		channel: string,
		options: { before?: number; limit?: number; since?: number } = {},
	): ChatHistoryResult {
		const limit = Math.min(
			options.limit ?? CHAT_LIMITS.historyPage,
			CHAT_LIMITS.historyPageMax,
		)
		const sinceClause = options.since ? ' AND created_at >= ?' : ''
		const sinceArgs = options.since ? [options.since] : []
		const rows =
			options.before === undefined
				? this.all<MessageRow>(
						`SELECT * FROM messages
							WHERE channel_id = ? AND parent_id IS NULL${sinceClause}
							ORDER BY id DESC LIMIT ?`,
						channel,
						...sinceArgs,
						limit + 1,
					)
				: this.all<MessageRow>(
						`SELECT * FROM messages
							WHERE channel_id = ? AND parent_id IS NULL AND id < ?${sinceClause}
							ORDER BY id DESC LIMIT ?`,
						channel,
						options.before,
						...sinceArgs,
						limit + 1,
					)
		const hasMore = rows.length > limit
		const page = rows.slice(0, limit).reverse()
		const messages = this.hydrate(page)
		return {
			messages,
			hasMore,
			people: this.getPeople(messages.map((message) => message.author)),
		}
	}

	thread(
		channel: string,
		parentId: number,
		options: { before?: number; limit?: number; since?: number } = {},
	) {
		const parent = this.getMessage(parentId)
		if (!parent || parent.channel !== channel || parent.parent !== null) {
			return null
		}
		if (options.since && parent.createdAt < options.since) {
			return {
				parent,
				replies: [],
				hasMore: false,
				people: this.getPeople([parent.author]),
			}
		}
		const limit = Math.min(
			options.limit ?? CHAT_LIMITS.threadPage,
			CHAT_LIMITS.threadPageMax,
		)
		const sinceClause = options.since ? ' AND created_at >= ?' : ''
		const sinceArgs = options.since ? [options.since] : []
		// Newest page first; the client keeps paging upward with `before`.
		const newestFirst =
			options.before === undefined
				? this.all<MessageRow>(
						`SELECT * FROM messages WHERE parent_id = ?${sinceClause}
							ORDER BY id DESC LIMIT ?`,
						parentId,
						...sinceArgs,
						limit + 1,
					)
				: this.all<MessageRow>(
						`SELECT * FROM messages WHERE parent_id = ? AND id < ?${sinceClause}
							ORDER BY id DESC LIMIT ?`,
						parentId,
						options.before,
						...sinceArgs,
						limit + 1,
					)
		const hasMore = newestFirst.length > limit
		const rows = newestFirst.slice(0, limit).reverse()
		const replies = this.hydrate(rows)
		return {
			parent,
			replies,
			hasMore,
			people: this.getPeople([
				parent.author,
				...replies.map((reply) => reply.author),
			]),
		}
	}

	toggleReaction(
		messageId: number,
		userId: string,
		emoji: string,
		now: number,
	) {
		const existing = this.all(
			`SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
			messageId,
			userId,
			emoji,
		)
		if (existing.length > 0) {
			this.run(
				`DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
				messageId,
				userId,
				emoji,
			)
		} else {
			const [{ emojiCount }] = this.all<{ emojiCount: number }>(
				`SELECT COUNT(DISTINCT emoji) AS emojiCount FROM reactions WHERE message_id = ?`,
				messageId,
			) as [{ emojiCount: number }]
			const emojiAlreadyUsed =
				this.all(
					`SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ? LIMIT 1`,
					messageId,
					emoji,
				).length > 0
			if (!emojiAlreadyUsed && emojiCount >= CHAT_LIMITS.reactionsPerMessage) {
				throw new ChatStoreError(
					'conflict',
					'This message already has the maximum number of different reactions.',
				)
			}
			this.run(
				`INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)`,
				messageId,
				userId,
				emoji,
				now,
			)
		}
		return this.getMessage(messageId)?.reactions ?? ([] as ChatReaction[])
	}

	markRead(channel: string, userId: string, upTo: number) {
		const [latest] = this.all<{ latest: number | null }>(
			`SELECT MAX(id) AS latest FROM messages WHERE channel_id = ?`,
			channel,
		)
		const target = Math.min(upTo, latest?.latest ?? 0)
		if (target <= 0) return
		this.run(
			`INSERT INTO reads (channel_id, user_id, last_read_id) VALUES (?, ?, ?)
				ON CONFLICT (channel_id, user_id) DO UPDATE SET
					last_read_id = MAX(last_read_id, excluded.last_read_id)`,
			channel,
			userId,
			target,
		)
	}

	unread(channels: string[], userId: string): ChatUnread[] {
		return [...new Set(channels)].map((channel) => {
			const [row] = this.all<{
				unread: number
				last_read_id: number
				latest_id: number
			}>(
				`SELECT
					(SELECT COUNT(*) FROM messages
						WHERE channel_id = ? AND deleted_at IS NULL AND author_id != ?
						AND id > COALESCE((SELECT last_read_id FROM reads
							WHERE channel_id = ? AND user_id = ?), 0)) AS unread,
					COALESCE((SELECT last_read_id FROM reads
						WHERE channel_id = ? AND user_id = ?), 0) AS last_read_id,
					COALESCE((SELECT MAX(id) FROM messages WHERE channel_id = ?), 0) AS latest_id`,
				channel,
				userId,
				channel,
				userId,
				channel,
				userId,
				channel,
			)
			return {
				channel,
				unread: row?.unread ?? 0,
				lastReadId: row?.last_read_id ?? 0,
				latestId: row?.latest_id ?? 0,
			}
		})
	}

	/** Deletes messages (and reactions) with `created_at` before `cutoffMs`. */
	pruneMessagesBefore(cutoffMs: number): number {
		const ids = this.all<{ id: number }>(
			`SELECT id FROM messages WHERE created_at < ?`,
			cutoffMs,
		).map((row) => row.id)
		if (ids.length === 0) return 0
		for (const part of chunk(ids)) {
			const inList = part.map(() => '?').join(', ')
			this.run(
				`DELETE FROM message_attachments WHERE message_id IN (${inList})`,
				...part,
			)
			this.run(`DELETE FROM reactions WHERE message_id IN (${inList})`, ...part)
			this.run(`DELETE FROM messages WHERE id IN (${inList})`, ...part)
		}
		return ids.length
	}

	deleteChannel(channel: string) {
		this.run(
			`DELETE FROM message_attachments WHERE message_id IN
				(SELECT id FROM messages WHERE channel_id = ?)`,
			channel,
		)
		this.run(
			`DELETE FROM reactions WHERE message_id IN
				(SELECT id FROM messages WHERE channel_id = ?)`,
			channel,
		)
		this.run(`DELETE FROM reads WHERE channel_id = ?`, channel)
		this.run(`DELETE FROM messages WHERE channel_id = ?`, channel)
	}
}
