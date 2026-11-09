// @vitest-environment jsdom
import { Editor } from '@tiptap/core'
import { gitHubEmojis } from '@tiptap/extension-emoji'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import { expect, test } from 'vitest'
import { ChatEmoji } from './chat-emoji.ts'

function createEditor(content = '') {
	return new Editor({
		element: document.createElement('div'),
		extensions: [
			StarterKit.configure({ heading: false }),
			Markdown.configure({ html: false }),
			ChatEmoji.configure({ emojis: gitHubEmojis, enableEmoticons: true }),
		],
		content,
	})
}

function getMarkdown(editor: Editor) {
	const storage = editor.storage as unknown as {
		markdown: { getMarkdown(): string }
	}
	return storage.markdown.getMarkdown()
}

function type(editor: Editor, text: string) {
	for (const ch of text) {
		const { from, to } = editor.state.selection
		const handled = editor.view.someProp('handleTextInput', (f) =>
			f(editor.view, from, to, ch, () =>
				editor.state.tr.insertText(ch, from, to),
			),
		)
		if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to))
	}
}

function insertEmoji(editor: Editor, name: string) {
	editor.commands.insertContent({ type: 'emoji', attrs: { name } })
}

test('an emoji node serializes to its unicode character', () => {
	const editor = createEditor()
	type(editor, 'hello :grinning: **bold**')
	const out = getMarkdown(editor)
	editor.destroy()
	expect(out).toContain('😀')
	expect(out).not.toContain('[emoji]')
	expect(out).toContain('**bold**')
})

test('an emoji without a unicode form falls back to its shortcode', () => {
	const editor = createEditor()
	insertEmoji(editor, 'custom_party')
	const out = getMarkdown(editor)
	editor.destroy()
	expect(out).toBe(':custom_party:')
})

test('a crafted emoji name is never written as markdown', () => {
	for (const name of ['a**b', 'x\n# heading', '[l](https://evil.test)', '']) {
		const editor = createEditor()
		insertEmoji(editor, name)
		const out = getMarkdown(editor)
		editor.destroy()
		expect(out.trim()).toBe('')
	}
})

test('serialized output loads back as text and serializes the same', () => {
	const editor = createEditor()
	type(editor, 'hi :grinning:')
	const first = getMarkdown(editor)
	editor.destroy()

	const reloaded = createEditor(first)
	expect(reloaded.getText()).toContain('😀')
	expect(getMarkdown(reloaded)).toBe(first)
	reloaded.destroy()
})

test('an image-only emoji shortcode loads back as an emoji node', () => {
	const editor = createEditor('so :octocat: here')
	const json = JSON.stringify(editor.getJSON())
	expect(json).toContain('"type":"emoji"')
	expect(getMarkdown(editor)).toBe('so :octocat: here')
	editor.destroy()
})

test('shortcodes inside code stay literal when loading', () => {
	const editor = createEditor('`:octocat:`\n\n```\n:octocat:\n```')
	expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"emoji"')
	editor.destroy()
})
