import { type MentionNodeAttrs } from '@tiptap/extension-mention'
import { ReactRenderer } from '@tiptap/react'
import { type SuggestionOptions } from '@tiptap/suggestion'
import tippy, { type Instance as TippyInstance } from 'tippy.js'
import { type MentionUser } from './comment-input'
import { MentionList } from './mention-list'

export default function getSuggestions(
	items: MentionUser[] | (() => MentionUser[]),
): Omit<SuggestionOptions<any, MentionNodeAttrs>, 'editor'> {
	const resolveItems = () => (typeof items === 'function' ? items() : items)
	return {
		items: ({ query }: { query: string }): MentionUser[] => {
			return resolveItems()
				.filter((item) =>
					item.name.toLowerCase().startsWith(query.toLowerCase()),
				)
				.slice(0, 5)
		},
		render: () => {
			let reactRenderer: ReactRenderer | null = null
			let popup: TippyInstance[] | null = null

			return {
				onStart: (props) => {
					if (!props.clientRect) {
						return
					}

					reactRenderer = new ReactRenderer(MentionList, {
						props,
						editor: props.editor,
					})

					popup = tippy('body', {
						getReferenceClientRect: props.clientRect as any,
						appendTo: () => document.body,
						content: reactRenderer.element,
						showOnCreate: true,
						interactive: true,
						trigger: 'manual',
						placement: 'bottom-start',
						zIndex: 9999,
					})
				},

				onUpdate(props) {
					if (!reactRenderer || !popup) return

					reactRenderer.updateProps(props)

					if (!props.clientRect) {
						return
					}

					popup?.[0]?.setProps({
						getReferenceClientRect: props.clientRect as any,
					})
				},

				onKeyDown(props) {
					if (!popup || !reactRenderer) return false

					if (props.event.key === 'Escape') {
						popup?.[0]?.hide()
						return true
					}

					return (reactRenderer.ref as any)?.onKeyDown?.(props) ?? false
				},

				onExit() {
					popup?.[0]?.destroy()
					if (reactRenderer) reactRenderer.destroy()
				},
			}
		},
	}
}
