import { chatMentionMarkdown } from '@repo/common/chat-markdown'
import Mention from '@tiptap/extension-mention'
import { PluginKey } from '@tiptap/pm/state'
import { type MarkdownNodeSpec } from 'tiptap-markdown'

export const CHAT_MENTION_PLUGIN_KEY = new PluginKey<{ active: boolean }>(
	'chat-mention',
)

export const ChatMention = Mention.extend({
	addStorage() {
		const markdown: MarkdownNodeSpec = {
			serialize(state, node) {
				state.write(
					chatMentionMarkdown(
						String(node.attrs.label ?? node.attrs.id ?? ''),
						String(node.attrs.id ?? ''),
					),
				)
			},
			parse: {
				updateDOM(element) {
					for (const link of element.querySelectorAll('a[href^="user:"]')) {
						const prefix = link.previousSibling
						const id = link.getAttribute('href')?.slice('user:'.length)
						if (
							!id ||
							!prefix ||
							prefix.nodeType !== Node.TEXT_NODE ||
							!prefix.textContent?.endsWith('@')
						) {
							continue
						}
						const label = link.textContent ?? ''
						const mention = element.ownerDocument.createElement('span')
						mention.setAttribute('data-type', 'mention')
						mention.setAttribute('data-id', id)
						mention.setAttribute('data-label', label)
						mention.setAttribute('data-mention-suggestion-char', '@')
						mention.textContent = `@${label}`
						prefix.textContent = prefix.textContent.slice(0, -1)
						link.replaceWith(mention)
					}
				},
			},
		}
		return { markdown }
	},
})
