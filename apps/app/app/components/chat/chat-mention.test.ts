// @vitest-environment jsdom

import {
	extractChatMentionUserIds,
	normalizeChatMessageBody,
} from '@repo/common/chat-markdown'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown, type MarkdownStorage } from 'tiptap-markdown'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatMention } from './chat-mention.ts'

const editors: Editor[] = []

function createEditor(body: string) {
	const editor = new Editor({
		extensions: [StarterKit, Markdown.configure({ html: false }), ChatMention],
		content: normalizeChatMessageBody(body),
	})
	editors.push(editor)
	return editor
}

function savedBody(editor: Editor) {
	const storage = editor.storage as { markdown?: MarkdownStorage }
	if (!storage.markdown) throw new Error('Markdown storage is not initialized')
	return storage.markdown.getMarkdown()
}

afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy()
})

describe('chat mention editing', () => {
	it.each([
		'@[Test User](user:member-1) hello',
		'<span class="mention bg-primary/10" data-type="mention" data-id="member-1" data-label="Test User" data-mention-suggestion-char="@">@Test User</span> hello',
		'@mention{id="member-1" label="Test User"} hello',
	])('opens stored mentions as editable chips: %s', (body) => {
		const editor = createEditor(body)
		expect(editor.getText()).toBe('@Test User hello')
		expect(editor.getJSON().content?.[0]?.content?.[0]).toMatchObject({
			type: 'mention',
			attrs: { id: 'member-1', label: 'Test User' },
		})
		expect(savedBody(editor)).toBe('@[Test User](user:member-1) hello')
	})

	it('preserves mention identity when the surrounding text changes', () => {
		const editor = createEditor('@[Test User](user:member-1) hello')
		editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' team')
		const body = savedBody(editor)
		expect(body).toBe('@[Test User](user:member-1) hello team')
		expect(extractChatMentionUserIds(body)).toEqual(['member-1'])
	})

	it('serializes newly inserted mentions without HTML', () => {
		const editor = createEditor('')
		editor.commands.insertContent({
			type: 'mention',
			attrs: { id: 'member-2', label: 'Sam' },
		})
		expect(savedBody(editor)).toBe('@[Sam](user:member-2)')
		expect(savedBody(editor)).not.toContain('<span')
	})

	it('preserves formatting, multiple mentions, and ordinary links', () => {
		const editor = createEditor(
			'**Hi** @[Sam](user:member-1) and @[Jules](user:member-2)\n\n[Docs](https://example.com)',
		)
		const body = savedBody(editor)
		expect(body).toContain('**Hi**')
		expect(extractChatMentionUserIds(body)).toEqual(['member-1', 'member-2'])
		expect(body).toContain('[Docs](https://example.com)')
	})

	it('does not convert mentions inside code or ordinary user links into chips', () => {
		const editor = createEditor(
			'`@[Sam](user:member-1)` and [profile](user:member-2)',
		)
		expect(editor.view.dom.querySelector('[data-type="mention"]')).toBeNull()
		expect(savedBody(editor)).toContain('`@[Sam](user:member-1)`')
	})

	it('treats raw HTML as text instead of enabling HTML parsing', () => {
		const editor = createEditor('<img src=x onerror=alert(1)> hello')
		expect(editor.view.dom.querySelector('img')).toBeNull()
		expect(editor.getText()).toContain('<img src=x onerror=alert(1)>')
	})
})
