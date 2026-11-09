import { Emoji, shortcodeToEmoji } from '@tiptap/extension-emoji'
import { type MarkdownNodeSpec } from 'tiptap-markdown'

/**
 * `tiptap-markdown` cannot serialize the Emoji node in non-HTML mode: it
 * writes the literal text `[emoji]`. Write the unicode character instead (or
 * the `:shortcode:` when the name has no unicode form).
 */
const SAFE_SHORTCODE = /^[a-z0-9_+-]+$/i
const SHORTCODE_PATTERN = /:([a-z0-9_+-]+):/gi

export const ChatEmoji = Emoji.extend({
	addStorage() {
		const parentStorage = this.parent!()
		const emojis = this.options.emojis
		const markdown: MarkdownNodeSpec = {
			serialize(state, node) {
				const name = String(node.attrs.name ?? '')
				const item = shortcodeToEmoji(name, emojis)
				// `name` can come from pasted HTML, so never write it unless it is a
				// plain shortcode (state.write does not escape markdown).
				state.write(
					item?.emoji ?? (SAFE_SHORTCODE.test(name) ? `:${name}:` : ''),
				)
			},
			parse: {
				// Restore image-only emoji (no unicode form) saved as `:name:`.
				updateDOM(element) {
					const walker = element.ownerDocument.createTreeWalker(
						element,
						NodeFilter.SHOW_TEXT,
					)
					const texts: Text[] = []
					for (let n = walker.nextNode(); n; n = walker.nextNode()) {
						texts.push(n as Text)
					}
					for (const text of texts) {
						const value = text.data
						if (!value.includes(':')) continue
						if (text.parentElement?.closest('code, pre')) continue
						const fragment = element.ownerDocument.createDocumentFragment()
						let last = 0
						let changed = false
						for (const match of value.matchAll(SHORTCODE_PATTERN)) {
							const name = match[1]!
							const item = shortcodeToEmoji(name, emojis)
							if (!item || item.emoji) continue
							fragment.append(value.slice(last, match.index))
							const span = element.ownerDocument.createElement('span')
							span.setAttribute('data-type', 'emoji')
							span.setAttribute('data-name', item.name)
							fragment.append(span)
							last = match.index + match[0].length
							changed = true
						}
						if (!changed) continue
						fragment.append(value.slice(last))
						text.replaceWith(fragment)
					}
				},
			},
		}
		return { ...parentStorage, markdown } as typeof parentStorage
	},
})
