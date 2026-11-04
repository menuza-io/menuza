import { escapeHtml } from './markdown'

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']

/**
 * Renders CMS Lexical content to HTML for `set:html`. Every text value is
 * escaped, and the heading tag is limited to h1-h6: the content is stored by
 * CMS editors and shown to every visitor, so it must never reach the page as
 * markup.
 */
export const renderLexicalContent = (content: any) => {
	if (!content || !content.root || !content.root.children) {
		return ''
	}

	return content.root.children
		.map((node: any) => {
			if (node.type === 'paragraph' && node.children) {
				const text = node.children
					.map((child: any) => {
						if (child.format && child.format > 0) {
							let formattedText = escapeHtml(String(child.text ?? ''))
							if (child.format & 1)
								formattedText = `<strong class="font-semibold text-foreground">${formattedText}</strong>`
							if (child.format & 2)
								formattedText = `<em class="italic">${formattedText}</em>`
							return formattedText
						}
						return escapeHtml(String(child.text ?? ''))
					})
					.join('')
				return `<p class="mb-4 text-[16px] leading-relaxed text-muted-foreground">${text}</p>`
			}
			if (node.type === 'heading' && node.children) {
				const text = node.children
					.map((child: any) => escapeHtml(String(child.text ?? '')))
					.join('')
				const tag = HEADING_TAGS.includes(node.tag) ? node.tag : 'h2'
				const headingClasses: Record<string, string> = {
					h1: 'font-display mb-6 text-[32px] font-medium tracking-[-0.02em] text-foreground sm:text-[40px]',
					h2: 'font-display mb-5 text-[28px] font-medium tracking-[-0.02em] text-foreground sm:text-[32px]',
					h3: 'mb-4 text-[22px] font-medium text-foreground',
					h4: 'mb-3 text-[18px] font-medium text-foreground',
					h5: 'mb-3 text-[16px] text-foreground',
					h6: 'mb-2 text-[15px] text-foreground',
				}
				return `<${tag} class="${headingClasses[tag] || headingClasses.h2}">${text}</${tag}>`
			}
			if (node.type === 'list' && node.children) {
				const listItems = node.children
					.map((item: any) => {
						if (item.type === 'listitem' && item.children) {
							const itemText = item.children
								.map((child: any) => {
									if (child.type === 'paragraph' && child.children) {
										return child.children
											.map((textChild: any) =>
												escapeHtml(String(textChild.text ?? '')),
											)
											.join('')
									}
									return escapeHtml(String(child.text ?? ''))
								})
								.join('')
							return `<li class="mb-2 text-[16px] leading-relaxed text-muted-foreground">${itemText}</li>`
						}
						return ''
					})
					.join('')
				if (node.listType === 'number') {
					return `<ol class="mb-6 list-decimal space-y-2 pl-6">${listItems}</ol>`
				}
				return `<ul class="mb-6 list-disc space-y-2 pl-6">${listItems}</ul>`
			}
			if (node.type === 'quote' && node.children) {
				const text = node.children
					.map((child: any) => {
						if (child.type === 'paragraph' && child.children) {
							return child.children
								.map((textChild: any) =>
									escapeHtml(String(textChild.text ?? '')),
								)
								.join('')
						}
						return escapeHtml(String(child.text ?? ''))
					})
					.join('')
				return `<blockquote class="my-6 rounded-2xl bg-brand-soft/40 p-5 text-[16px] italic text-foreground">"${text}"</blockquote>`
			}
			return ''
		})
		.join('')
}
