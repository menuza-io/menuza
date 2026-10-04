import { describe, expect, it } from 'vitest'
import {
	chatMentionMarkdown,
	extractChatMentionUserIds,
	normalizeChatMessageBody,
} from './chat-markdown.ts'

describe('chat-markdown', () => {
	it('round-trips mention tokens', () => {
		const body = chatMentionMarkdown('Test User', 'user-1')
		expect(body).toBe('@[Test User](user:user-1)')
		expect(extractChatMentionUserIds(body)).toEqual(['user-1'])
	})

	it('normalizes tiptap HTML mention spans', () => {
		const html = `Hi <span class="mention bg-primary/10" data-type="mention" data-id="gitnu4" data-label="Test User" data-mention-suggestion-char="@">@Test User</span>`
		expect(normalizeChatMessageBody(html)).toBe('Hi @[Test User](user:gitnu4)')
	})

	it('normalizes inline @mention markdown', () => {
		const raw = 'Hey @mention{id="abc" label="Ada"}'
		expect(normalizeChatMessageBody(raw)).toBe('Hey @[Ada](user:abc)')
	})
})
