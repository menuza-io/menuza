import { DurableObject } from 'cloudflare:workers'
import {
	ChatEngine,
	type ChatConnection,
} from '../app/modules/chat/chat-engine.ts'
import { ChatStore } from '../app/modules/chat/chat-store.ts'
import { CHAT_HEADERS } from '../app/utils/chat/namespace.server.ts'
import { applyWorkerEnv } from './worker-env.ts'

/** Organization ids are cuid2: lowercase alphanumerics. */
const ORG_ID_PATTERN = /^[a-z0-9]{8,64}$/i

/** Survives hibernation on the socket itself (limit 2 KB). */
type SocketAttachment = {
	id: string
	userId: string
	canModerate: boolean
}

/**
 * One chat room per organization.
 *
 * The room holds message data in its own SQLite storage and fans messages out
 * over WebSockets (hibernation API: idle rooms cost nothing). It never decides
 * who may see a channel: `resolveAudiences` asks the control-plane D1, and the
 * engine caches the answer for ~30 seconds. D1 is not written per message.
 */
export class ChatOrg extends DurableObject<Env> {
	private readonly store: ChatStore
	private readonly engine: ChatEngine
	private orgId: string | null = null
	private ready: ReturnType<ChatOrg['load']> | null = null

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.store = new ChatStore(ctx.storage.sql)
		void ctx.blockConcurrencyWhile(async () => {
			this.store.migrate()
			this.orgId = this.store.getMeta('orgId')
		})
		this.engine = new ChatEngine({
			store: this.store,
			connections: () => this.connections(),
			resolveAudiences: async (channelIds) => {
				const { audience } = await this.prepare()
				return audience.resolveChannelAudiences(this.requireOrgId(), channelIds)
			},
			isModerator: async (userId) => {
				const { auth } = await this.prepare()
				return auth.userHasOrganizationPermission(
					userId,
					this.requireOrgId(),
					auth.ORG_PERMISSIONS.UPDATE_CHAT_ANY,
				)
			},
			historyCutoff: async (userId, channelId) => {
				const { conversations } = await this.prepare()
				return conversations.getMessageHistoryCutoff(
					this.requireOrgId(),
					userId,
					channelId,
				)
			},
			onMessageSent: async ({ message, authorId }) => {
				await this.notifyAppMessage(authorId, message)
			},
		})
	}

	private async notifyAppMessage(
		authorId: string,
		message: import('@repo/common/chat').ChatMessage,
	) {
		const base = this.env.BASE_URL
		const token = this.env.INTERNAL_COMMAND_TOKEN
		if (!base || !token || !this.orgId) return
		try {
			await fetch(`${base}/resources/chat/notify`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					organizationId: this.orgId,
					authorId,
					message,
				}),
			})
		} catch (error) {
			console.warn('Chat notify failed', error)
		}
	}

	/**
	 * Apply env and bind D1 once per instance, before any control-plane read.
	 * These packages are imported lazily, after the env is applied, exactly as
	 * the Worker entry does: they may read ENV.* when first evaluated.
	 */
	private async load() {
		applyWorkerEnv(this.env)
		const [database, auth, audience, conversations] = await Promise.all([
			import('@repo/database'),
			import('@repo/auth'),
			import('../app/utils/chat/audience.server.ts'),
			import('../app/utils/chat/conversations.server.ts'),
		])
		database.bindCloudflareD1(this.env.DB)
		return { auth, audience, conversations }
	}

	private prepare() {
		this.ready ??= this.load()
		return this.ready
	}

	private requireOrgId() {
		if (!this.orgId) throw new Error('ChatOrg has no organization')
		return this.orgId
	}

	private connections(): ChatConnection[] {
		const live: ChatConnection[] = []
		for (const socket of this.ctx.getWebSockets()) {
			const conn = this.connectionFor(socket)
			if (conn) live.push(conn)
		}
		return live
	}

	private connectionFor(socket: WebSocket): ChatConnection | null {
		const attachment = socket.deserializeAttachment() as SocketAttachment | null
		if (!attachment) return null
		return {
			...attachment,
			send: (frame) => {
				try {
					socket.send(frame)
				} catch {
					// Socket already closing; the close handler cleans up.
				}
			},
			close: (code, reason) => {
				try {
					socket.close(code, reason)
				} catch {
					// Already closed.
				}
			},
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/rpc/unread') {
			const userId = request.headers.get(CHAT_HEADERS.user)
			const channelsRaw = request.headers.get('x-chat-channels')
			if (!userId || !channelsRaw) {
				return new Response('Bad request', { status: 400 })
			}
			let channelIds: string[] = []
			try {
				channelIds = JSON.parse(channelsRaw) as string[]
			} catch {
				return new Response('Bad request', { status: 400 })
			}
			const total = this.store
				.unread(channelIds, userId)
				.reduce((sum, row) => sum + row.unread, 0)
			return Response.json({ total })
		}

		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected a WebSocket upgrade', { status: 426 })
		}
		// Set by the Worker after it authenticated the session. This object is
		// only reachable through the Worker's binding, never directly.
		const orgId = request.headers.get(CHAT_HEADERS.org)
		const userId = request.headers.get(CHAT_HEADERS.user)
		if (!orgId || !ORG_ID_PATTERN.test(orgId) || !userId) {
			return new Response('Bad request', { status: 400 })
		}
		if (this.orgId && this.orgId !== orgId) {
			return new Response('Bad request', { status: 400 })
		}
		if (!this.orgId) {
			this.orgId = orgId
			this.store.setMeta('orgId', orgId)
		}

		const name = decode(request.headers.get(CHAT_HEADERS.name)) || 'Member'
		const image = decode(request.headers.get(CHAT_HEADERS.image)) || null
		const attachment: SocketAttachment = {
			id: crypto.randomUUID(),
			userId,
			canModerate: request.headers.get(CHAT_HEADERS.moderator) === '1',
		}

		const pair = new WebSocketPair()
		const [client, server] = [pair[0], pair[1]]
		server.serializeAttachment(attachment)
		this.ctx.acceptWebSocket(server)

		const conn = this.connectionFor(server)!
		this.engine.open(conn, { id: userId, name, image })
		void this.scheduleRetentionAlarm()
		return new Response(null, { status: 101, webSocket: client })
	}

	async alarm() {
		await this.runRetentionPrune()
		await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000)
	}

	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
		const conn = this.connectionFor(socket)
		if (!conn) return
		try {
			await this.engine.handle(conn, message)
		} catch (error) {
			console.error('Chat frame failed', error)
		}
	}

	webSocketClose(socket: WebSocket, code: number) {
		const conn = this.connectionFor(socket)
		try {
			// 1005/1006/1015 are reserved and cannot be echoed back.
			socket.close(
				code >= 1000 && ![1005, 1006, 1015].includes(code) ? code : 1000,
			)
		} catch {
			// Already closed.
		}
		if (conn) this.engine.close(conn)
	}

	webSocketError(socket: WebSocket) {
		const conn = this.connectionFor(socket)
		if (conn) this.engine.close(conn)
	}

	// ── RPC: called by the app after access changes ────────────────────────

	evictUser(userId: string) {
		this.engine.evictUser(userId)
	}

	invalidate() {
		this.engine.invalidate()
	}

	channelsChanged() {
		this.engine.channelsChanged()
	}

	deleteChannel(channelId: string) {
		this.engine.deleteChannel(channelId)
	}

	async runRetentionPrune() {
		if (!this.orgId) return 0
		await this.prepare()
		const { db, eq, Organization } = await import('@repo/database')
		const [row] = await db
			.select({ days: Organization.chatRetentionDays })
			.from(Organization)
			.where(eq(Organization.id, this.orgId))
			.limit(1)
		const days = row?.days
		if (!days || days <= 0) return 0
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
		return this.store.pruneMessagesBefore(cutoff)
	}

	private async scheduleRetentionAlarm() {
		const existing = await this.ctx.storage.getAlarm()
		if (!existing) {
			await this.ctx.storage.setAlarm(Date.now() + 60_000)
		}
	}
}

function decode(value: string | null) {
	if (!value) return ''
	try {
		return decodeURIComponent(value)
	} catch {
		return ''
	}
}
