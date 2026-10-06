import { type ChatMessage } from '@repo/common/chat'
import { describe, expect, it } from 'vitest'
import { isSameMessageDay, showMessageHeader } from './chat-presentation.ts'

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: 1,
		channel: 'general',
		parent: null,
		author: 'member',
		body: 'Hello',
		attachments: [],
		createdAt: new Date(2026, 9, 6, 10).getTime(),
		editedAt: null,
		deleted: false,
		replyCount: 0,
		lastReplyAt: null,
		reactions: [],
		...overrides,
	}
}

describe('chat message grouping', () => {
	it('shows the author at the start of a conversation', () => {
		expect(showMessageHeader(message(), undefined)).toBe(true)
	})

	it('groups consecutive messages from the same author within five minutes', () => {
		const previous = message()
		expect(
			showMessageHeader(
				message({ createdAt: previous.createdAt + 5 * 60_000 }),
				previous,
			),
		).toBe(false)
	})

	it('shows the author again after a longer pause', () => {
		const previous = message()
		expect(
			showMessageHeader(
				message({ createdAt: previous.createdAt + 5 * 60_000 + 1 }),
				previous,
			),
		).toBe(true)
	})

	it('starts a new group when the author changes', () => {
		expect(showMessageHeader(message({ author: 'other' }), message())).toBe(
			true,
		)
	})

	it('starts a new group after a deleted message', () => {
		expect(showMessageHeader(message(), message({ deleted: true }))).toBe(true)
	})

	it('shows the author after a day separator, even within five minutes', () => {
		const previous = message({
			createdAt: new Date(2026, 9, 5, 23, 59).getTime(),
		})
		const next = message({
			createdAt: new Date(2026, 9, 6, 0, 1).getTime(),
		})
		expect(isSameMessageDay(previous.createdAt, next.createdAt)).toBe(false)
		expect(showMessageHeader(next, previous)).toBe(true)
	})

	it('compares calendar dates, not elapsed 24-hour windows', () => {
		expect(
			isSameMessageDay(
				new Date(2026, 9, 6, 0, 1).getTime(),
				new Date(2026, 9, 6, 23, 59).getTime(),
			),
		).toBe(true)
		expect(
			isSameMessageDay(
				new Date(2025, 9, 6).getTime(),
				new Date(2026, 9, 6).getTime(),
			),
		).toBe(false)
	})
})
