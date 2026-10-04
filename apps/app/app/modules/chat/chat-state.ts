import {
	type ChatHistoryResult,
	type ChatMessage,
	type ChatPerson,
	type ChatServerFrame,
	type ChatThreadResult,
	type ChatUnread,
} from '@repo/common/chat'

/** How long a "is typing" indicator lingers without a fresh signal. */
export const TYPING_TTL_MS = 4_000

export type ChatConnectionStatus =
	'connecting' | 'open' | 'reconnecting' | 'forbidden'

export type ChannelView = {
	/** Top-level messages, oldest first. */
	messages: ChatMessage[]
	/** Older history exists on the server. */
	hasMore: boolean
	loaded: boolean
	unread: number
	lastReadId: number
	latestId: number
	/** userId -> expiry (ms epoch) of the typing indicator. */
	typing: Record<string, number>
}

export type ChatState = {
	connection: ChatConnectionStatus
	me: { id: string; canModerate: boolean } | null
	online: string[]
	people: Record<string, ChatPerson>
	channels: Record<string, ChannelView>
	/** Thread replies by parent message id, oldest first. */
	threads: Record<number, ChatMessage[]>
	/** Older replies exist on the server for this thread. */
	threadMore: Record<number, boolean>
}

export type ChatAction =
	| {
			type: 'frame'
			frame: ChatServerFrame
			now: number
			/** The channel the user is looking at with the tab in the foreground. */
			viewing: string | null
	  }
	| { type: 'connection'; status: ChatConnectionStatus }
	| {
			type: 'history'
			channel: string
			result: ChatHistoryResult
			/** `replace` for the first/refresh load, `prepend` for older pages. */
			mode: 'replace' | 'prepend'
	  }
	| {
			type: 'thread'
			result: ChatThreadResult
			/** `replace` when opening a thread, `prepend` when paging upward. */
			mode: 'replace' | 'prepend'
	  }
	| { type: 'sync'; unread: ChatUnread[] }
	| { type: 'read'; channel: string }
	| { type: 'forget-channel'; channel: string }

export const initialChatState: ChatState = {
	connection: 'connecting',
	me: null,
	online: [],
	people: {},
	channels: {},
	threads: {},
	threadMore: {},
}

function emptyChannel(): ChannelView {
	return {
		messages: [],
		hasMore: false,
		loaded: false,
		unread: 0,
		lastReadId: 0,
		latestId: 0,
		typing: {},
	}
}

function channelOf(state: ChatState, channel: string) {
	return state.channels[channel] ?? emptyChannel()
}

function mergePeople(
	people: Record<string, ChatPerson>,
	incoming: ChatPerson[],
) {
	if (incoming.length === 0) return people
	const next = { ...people }
	for (const person of incoming) next[person.id] = person
	return next
}

/** Insert or replace by id, keeping ascending id order. */
function upsert(list: ChatMessage[], message: ChatMessage) {
	const index = list.findIndex((entry) => entry.id === message.id)
	if (index >= 0) {
		const next = list.slice()
		next[index] = message
		return next
	}
	return [...list, message].sort((a, b) => a.id - b.id)
}

function mergePages(older: ChatMessage[], current: ChatMessage[]) {
	const byId = new Map<number, ChatMessage>()
	for (const message of [...older, ...current]) byId.set(message.id, message)
	return [...byId.values()].sort((a, b) => a.id - b.id)
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
	switch (action.type) {
		case 'connection':
			return { ...state, connection: action.status }

		case 'history': {
			const view = channelOf(state, action.channel)
			const messages =
				action.mode === 'prepend'
					? mergePages(action.result.messages, view.messages)
					: // A refresh replaces the page but keeps anything newer that
						// arrived over the socket while the request was in flight.
						mergePages(
							action.result.messages,
							view.messages.filter(
								(message) =>
									message.id >
									(action.result.messages.at(-1)?.id ??
										Number.MAX_SAFE_INTEGER),
							),
						)
			return {
				...state,
				people: mergePeople(state.people, action.result.people),
				channels: {
					...state.channels,
					[action.channel]: {
						...view,
						messages,
						hasMore: action.result.hasMore,
						loaded: true,
					},
				},
			}
		}

		case 'thread': {
			const { parent, replies, people, hasMore } = action.result
			const view = channelOf(state, parent.channel)
			return {
				...state,
				people: mergePeople(state.people, people),
				threads: {
					...state.threads,
					[parent.id]:
						action.mode === 'prepend'
							? mergePages(replies, state.threads[parent.id] ?? [])
							: // Opening refreshes the newest page but keeps anything newer
								// that arrived over the socket while the request was in flight.
								mergePages(
									replies,
									(state.threads[parent.id] ?? []).filter(
										(reply) =>
											reply.id >
											(replies.at(-1)?.id ?? Number.MAX_SAFE_INTEGER),
									),
								),
				},
				threadMore: { ...state.threadMore, [parent.id]: hasMore },
				channels: {
					...state.channels,
					[parent.channel]: {
						...view,
						messages: view.messages.some((m) => m.id === parent.id)
							? upsert(view.messages, parent)
							: view.messages,
					},
				},
			}
		}

		case 'sync': {
			const channels = { ...state.channels }
			for (const entry of action.unread) {
				const view = channels[entry.channel] ?? emptyChannel()
				channels[entry.channel] = {
					...view,
					unread: entry.unread,
					lastReadId: entry.lastReadId,
					latestId: entry.latestId,
				}
			}
			return { ...state, channels }
		}

		case 'read': {
			const view = state.channels[action.channel]
			if (!view || (view.unread === 0 && view.lastReadId >= view.latestId)) {
				return state
			}
			return {
				...state,
				channels: {
					...state.channels,
					[action.channel]: {
						...view,
						unread: 0,
						lastReadId: view.latestId,
					},
				},
			}
		}

		case 'forget-channel': {
			const { [action.channel]: ignoredRemoved, ...channels } = state.channels
			return { ...state, channels }
		}

		case 'frame':
			return applyFrame(state, action.frame, action.now, action.viewing)
	}
}

function applyFrame(
	state: ChatState,
	frame: ChatServerFrame,
	now: number,
	viewing: string | null,
): ChatState {
	switch (frame.t) {
		case 'ready':
			return {
				...state,
				connection: 'open',
				me: frame.me,
				online: frame.online,
			}

		case 'presence': {
			const online = frame.online
				? state.online.includes(frame.user)
					? state.online
					: [...state.online, frame.user]
				: state.online.filter((id) => id !== frame.user)
			return { ...state, online }
		}

		case 'message': {
			const { message } = frame
			const view = channelOf(state, message.channel)
			const people = mergePeople(state.people, frame.people)
			const mine = message.author === state.me?.id
			const isNew =
				message.id > view.latestId &&
				!view.messages.some((entry) => entry.id === message.id) &&
				!(state.threads[message.parent ?? -1] ?? []).some(
					(entry) => entry.id === message.id,
				)
			const seen = mine || viewing === message.channel
			const latestId = Math.max(view.latestId, message.id)
			const next: ChannelView = {
				...view,
				latestId,
				lastReadId: seen ? latestId : view.lastReadId,
				unread: seen ? 0 : isNew ? view.unread + 1 : view.unread,
				// The author stopped typing the moment they sent.
				typing: omit(view.typing, message.author),
			}
			if (message.parent === null) {
				next.messages = upsert(view.messages, message)
				return {
					...state,
					people,
					channels: { ...state.channels, [message.channel]: next },
				}
			}
			const replies = state.threads[message.parent]
			return {
				...state,
				people,
				// Only keep replies for threads that are open/loaded; the parent's
				// `replyCount` (sent as `message.updated`) drives the list badge.
				threads: replies
					? { ...state.threads, [message.parent]: upsert(replies, message) }
					: state.threads,
				channels: { ...state.channels, [message.channel]: next },
			}
		}

		case 'message.updated': {
			const { message } = frame
			const view = channelOf(state, message.channel)
			if (message.parent === null) {
				return {
					...state,
					channels: {
						...state.channels,
						[message.channel]: {
							...view,
							messages: view.messages.some((entry) => entry.id === message.id)
								? upsert(view.messages, message)
								: view.messages,
						},
					},
				}
			}
			const replies = state.threads[message.parent]
			if (!replies?.some((entry) => entry.id === message.id)) return state
			return {
				...state,
				threads: {
					...state.threads,
					[message.parent]: upsert(replies, message),
				},
			}
		}

		case 'message.deleted': {
			const view = channelOf(state, frame.channel)
			if (frame.parent === null) {
				return {
					...state,
					channels: {
						...state.channels,
						[frame.channel]: {
							...view,
							// Keep a tombstone so a thread with replies stays readable.
							messages: view.messages.map((entry) =>
								entry.id === frame.id
									? { ...entry, deleted: true, body: '', reactions: [] }
									: entry,
							),
						},
					},
				}
			}
			const replies = state.threads[frame.parent]
			if (!replies) return state
			return {
				...state,
				threads: {
					...state.threads,
					[frame.parent]: replies.filter((entry) => entry.id !== frame.id),
				},
			}
		}

		case 'reactions': {
			const view = channelOf(state, frame.channel)
			const apply = (entry: ChatMessage) =>
				entry.id === frame.message
					? { ...entry, reactions: frame.reactions }
					: entry
			return {
				...state,
				channels: {
					...state.channels,
					[frame.channel]: { ...view, messages: view.messages.map(apply) },
				},
				threads: Object.fromEntries(
					Object.entries(state.threads).map(([parent, replies]) => [
						parent,
						replies.map(apply),
					]),
				),
			}
		}

		case 'typing': {
			if (frame.user === state.me?.id) return state
			const view = channelOf(state, frame.channel)
			return {
				...state,
				channels: {
					...state.channels,
					[frame.channel]: {
						...view,
						typing: { ...view.typing, [frame.user]: now + TYPING_TTL_MS },
					},
				},
			}
		}

		case 'channel.deleted': {
			const { [frame.channel]: ignoredRemoved, ...channels } = state.channels
			return { ...state, channels }
		}

		case 'ack':
		case 'pong':
		case 'channels.changed':
			return state
	}
}

function omit<T extends Record<string, number>>(record: T, key: string) {
	if (!(key in record)) return record
	const { [key]: ignoredRemoved, ...rest } = record
	return rest as T
}

/** User ids currently typing in a channel (excluding expired signals). */
export function typingUserIds(view: ChannelView | undefined, now: number) {
	if (!view) return []
	return Object.entries(view.typing)
		.filter(([, expiresAt]) => expiresAt > now)
		.map(([userId]) => userId)
}

/** Total unread across the given channels. */
export function totalUnread(state: ChatState, channelIds: string[]) {
	return channelIds.reduce(
		(sum, id) => sum + (state.channels[id]?.unread ?? 0),
		0,
	)
}
