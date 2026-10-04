import {
	CHAT_LIMITS,
	type ChatClientFrame,
	type ChatHistoryResult,
	type ChatMessage,
	type ChatSearchHit,
	type ChatServerFrame,
	type ChatThreadResult,
	type ChatUnread,
} from '@repo/common/chat'
import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
	chatReducer,
	initialChatState,
	type ChatState,
} from '#app/modules/chat/chat-state.ts'
import { notifyChatActivity } from '#app/hooks/use-chat-unread.ts'

const REQUEST_TIMEOUT_MS = 10_000
const PING_INTERVAL_MS = 25_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const FORBIDDEN_CLOSE = 4403
const TYPING_SEND_INTERVAL_MS = 2_000

/** Distributive Omit so each frame variant keeps its own fields. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type RequestFrame = WithoutId<Extract<ChatClientFrame, { id: string }>>

export class ChatRequestError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message)
		this.name = 'ChatRequestError'
	}
}

type Pending = {
	resolve(data: unknown): void
	reject(error: Error): void
	timer: ReturnType<typeof setTimeout>
}

export type UseChatOptions = {
	orgSlug: string
	/** Channels the user can open; used to seed unread counts. */
	channelIds: string[]
	/** Channel on screen; incoming messages there are read immediately. */
	activeChannel: string | null
	enabled: boolean
	/** Channel list changed on the server (created, edited or deleted). */
	onChannelsChanged(): void
}

export type ChatApi = {
	state: ChatState
	loadHistory(channel: string, before?: number): Promise<void>
	openThread(channel: string, parent: number, before?: number): Promise<void>
	send(
		channel: string,
		body: string,
		parent?: number,
		attachmentKeys?: string[],
	): Promise<ChatMessage>
	search(query: string): Promise<{
		results: ChatSearchHit[]
		people: ChatState['people']
	}>
	edit(message: number, body: string): Promise<void>
	remove(message: number): Promise<void>
	react(message: number, emoji: string): Promise<void>
	typing(channel: string): void
}

/**
 * One WebSocket per tab to the organization's chat room. Reconnects with
 * jittered backoff, resyncs unread counts and the open channel after a drop,
 * and never reconnects after the server says access was revoked (4403).
 */
export function useChat({
	orgSlug,
	channelIds,
	activeChannel,
	enabled,
	onChannelsChanged,
}: UseChatOptions): ChatApi {
	const [state, dispatch] = useReducer(chatReducer, initialChatState)
	const socketRef = useRef<WebSocket | null>(null)
	const pending = useRef(new Map<string, Pending>())
	const nextId = useRef(0)
	const lastTypingSent = useRef(0)

	// Latest values for callbacks that outlive a render (socket handlers).
	const latest = useRef({ channelIds, activeChannel, onChannelsChanged })
	latest.current = { channelIds, activeChannel, onChannelsChanged }

	const request = useCallback(
		<T>(frame: RequestFrame): Promise<T> =>
			new Promise<T>((resolve, reject) => {
				const socket = socketRef.current
				if (!socket || socket.readyState !== WebSocket.OPEN) {
					reject(new ChatRequestError('Not connected.', 'offline'))
					return
				}
				const id = `${Date.now().toString(36)}-${nextId.current++}`
				const timer = setTimeout(() => {
					pending.current.delete(id)
					reject(new ChatRequestError('The request timed out.', 'timeout'))
				}, REQUEST_TIMEOUT_MS)
				pending.current.set(id, {
					resolve: (data) => resolve(data as T),
					reject,
					timer,
				})
				socket.send(JSON.stringify({ ...frame, id }))
			}),
		[],
	)

	const syncAndRefresh = useCallback(async () => {
		const { channelIds, activeChannel } = latest.current
		try {
			if (channelIds.length > 0) {
				const { channels } = await request<{ channels: ChatUnread[] }>({
					t: 'sync',
					channels: channelIds.slice(0, CHAT_LIMITS.syncChannelsMax),
				})
				dispatch({ type: 'sync', unread: channels })
			}
			if (activeChannel) {
				const result = await request<ChatHistoryResult>({
					t: 'history',
					channel: activeChannel,
				})
				dispatch({
					type: 'history',
					channel: activeChannel,
					result,
					mode: 'replace',
				})
			}
		} catch {
			// The next reconnect or user action retries.
		}
	}, [request])

	useEffect(() => {
		if (!enabled || typeof window === 'undefined') return
		let disposed = false
		let retry: ReturnType<typeof setTimeout> | undefined
		let ping: ReturnType<typeof setInterval> | undefined
		let backoff = BACKOFF_MIN_MS

		const failPending = (reason: string) => {
			for (const entry of pending.current.values()) {
				clearTimeout(entry.timer)
				entry.reject(new ChatRequestError(reason, 'offline'))
			}
			pending.current.clear()
		}

		const connect = () => {
			if (disposed) return
			const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
			const socket = new WebSocket(
				`${scheme}//${window.location.host}/${encodeURIComponent(orgSlug)}/chat/ws`,
			)
			socketRef.current = socket

			socket.onmessage = (event) => {
				if (typeof event.data !== 'string') return
				let frame: ChatServerFrame
				try {
					frame = JSON.parse(event.data) as ChatServerFrame
				} catch {
					return
				}
				if (frame.t === 'ack') {
					const entry = pending.current.get(frame.id)
					if (!entry) return
					pending.current.delete(frame.id)
					clearTimeout(entry.timer)
					if (frame.ok) entry.resolve(frame.data)
					else entry.reject(new ChatRequestError(frame.message, frame.error))
					return
				}
				const { activeChannel } = latest.current
				dispatch({
					type: 'frame',
					frame,
					now: Date.now(),
					viewing:
						document.visibilityState === 'visible' ? activeChannel : null,
				})
				if (frame.t === 'message') {
					notifyChatActivity(orgSlug)
				}
				if (frame.t === 'ready') {
					backoff = BACKOFF_MIN_MS
					void syncAndRefresh()
				} else if (
					frame.t === 'channels.changed' ||
					frame.t === 'channel.deleted'
				) {
					latest.current.onChannelsChanged()
				}
			}

			socket.onclose = (event) => {
				if (socketRef.current === socket) socketRef.current = null
				clearInterval(ping)
				failPending('Disconnected.')
				if (disposed) return
				if (event.code === FORBIDDEN_CLOSE) {
					dispatch({ type: 'connection', status: 'forbidden' })
					return
				}
				dispatch({ type: 'connection', status: 'reconnecting' })
				const delay = backoff * (0.75 + Math.random() * 0.5)
				backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
				retry = setTimeout(connect, delay)
			}

			socket.onopen = () => {
				ping = setInterval(() => {
					if (socket.readyState === WebSocket.OPEN) {
						socket.send(JSON.stringify({ t: 'ping' }))
					}
				}, PING_INTERVAL_MS)
			}
		}

		connect()
		return () => {
			disposed = true
			clearTimeout(retry)
			clearInterval(ping)
			failPending('Disconnected.')
			const socket = socketRef.current
			socketRef.current = null
			socket?.close(1000)
		}
	}, [enabled, orgSlug, syncAndRefresh])

	// Mark the open channel read whenever something new lands while looking at it.
	const view = activeChannel ? state.channels[activeChannel] : undefined
	const latestId = view?.latestId ?? 0
	const connected = state.connection === 'open'
	// Highest message id we've told the server about, per channel. Local state
	// already shows "read" the instant a message lands while you're looking at
	// it, so it can't be used to decide whether the server needs to hear.
	const reportedRead = useRef(new Map<string, number>())
	useEffect(() => {
		if (!connected) reportedRead.current.clear()
	}, [connected])
	useEffect(() => {
		if (!connected || !activeChannel || latestId === 0) return
		const markIfVisible = () => {
			if (document.visibilityState !== 'visible') return
			dispatch({ type: 'read', channel: activeChannel })
			if ((reportedRead.current.get(activeChannel) ?? 0) >= latestId) return
			reportedRead.current.set(activeChannel, latestId)
			void request({ t: 'read', channel: activeChannel, upTo: latestId }).catch(
				() => reportedRead.current.delete(activeChannel),
			)
		}
		markIfVisible()
		document.addEventListener('visibilitychange', markIfVisible)
		return () => document.removeEventListener('visibilitychange', markIfVisible)
	}, [connected, activeChannel, latestId, request])

	const loadHistory = useCallback(
		async (channel: string, before?: number) => {
			const result = await request<ChatHistoryResult>({
				t: 'history',
				channel,
				before,
			})
			dispatch({
				type: 'history',
				channel,
				result,
				mode: before ? 'prepend' : 'replace',
			})
		},
		[request],
	)

	const openThread = useCallback(
		async (channel: string, parent: number, before?: number) => {
			const result = await request<ChatThreadResult>({
				t: 'thread',
				channel,
				parent,
				before,
			})
			dispatch({
				type: 'thread',
				result,
				mode: before ? 'prepend' : 'replace',
			})
		},
		[request],
	)

	const send = useCallback(
		async (
			channel: string,
			body: string,
			parent?: number,
			attachmentKeys?: string[],
		) => {
			const { message } = await request<{ message: ChatMessage }>({
				t: 'send',
				channel,
				body,
				parent,
				attachmentKeys,
			})
			notifyChatActivity(orgSlug)
			return message
		},
		[request, orgSlug],
	)

	const search = useCallback(
		async (query: string) => {
			const data = await request<{
				results: ChatSearchHit[]
				people: ChatState['people']
			}>({
				t: 'search',
				query,
				channels: channelIds,
			})
			return data
		},
		[request, channelIds],
	)

	const edit = useCallback(
		async (message: number, body: string) => {
			await request({ t: 'edit', message, body })
		},
		[request],
	)

	const remove = useCallback(
		async (message: number) => {
			await request({ t: 'delete', message })
		},
		[request],
	)

	const react = useCallback(
		async (message: number, emoji: string) => {
			await request({ t: 'react', message, emoji })
		},
		[request],
	)

	const typing = useCallback((channel: string) => {
		const socket = socketRef.current
		const now = Date.now()
		if (
			!socket ||
			socket.readyState !== WebSocket.OPEN ||
			now - lastTypingSent.current < TYPING_SEND_INTERVAL_MS
		) {
			return
		}
		lastTypingSent.current = now
		socket.send(JSON.stringify({ t: 'typing', channel }))
	}, [])

	return {
		state,
		loadHistory,
		openThread,
		send,
		search,
		edit,
		remove,
		react,
		typing,
	}
}
