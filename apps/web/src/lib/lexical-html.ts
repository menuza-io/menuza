import { escapeHtml, isSafeHref } from './markdown'

// The page template owns the single `h1`, so editor content starts at `h2`.
const HEADING_TAGS = ['h2', 'h3', 'h4', 'h5', 'h6']

const HEADING_CLASSES: Record<string, string> = {
	h2: 'font-display mb-5 text-[28px] font-medium tracking-[-0.02em] text-foreground sm:text-[32px]',
	h3: 'mb-4 text-[22px] font-medium text-foreground',
	h4: 'mb-3 text-[18px] font-medium text-foreground',
	h5: 'mb-3 text-[16px] text-foreground',
	h6: 'mb-2 text-[15px] text-foreground',
}

const headingTag = (tag: unknown) =>
	tag === 'h1'
		? 'h2'
		: HEADING_TAGS.includes(tag as string)
			? (tag as string)
			: 'h2'

/** A node's child list, or an empty one when the stored shape is not an array. */
const childrenOf = (node: any): any[] =>
	Array.isArray(node?.children) ? node.children : []

/** Text, bold/italic text, links and line breaks, all escaped. */
function renderInline(child: any): string {
	if (!child || typeof child !== 'object') return ''
	if (child.type === 'linebreak') return '<br />'
	if (child.type === 'link' || child.type === 'autolink') {
		const rawUrl = String(child.url ?? child.fields?.url ?? '')
		const label = childrenOf(child).map(renderInline).join('')
		if (!isSafeHref(rawUrl)) return label
		return `<a href="${escapeHtml(rawUrl)}" class="underline underline-offset-2" rel="noopener noreferrer">${label}</a>`
	}
	let text = escapeHtml(String(child.text ?? ''))
	if (child.format && child.format > 0) {
		if (child.format & 1)
			text = `<strong class="font-semibold text-foreground">${text}</strong>`
		if (child.format & 2) text = `<em class="italic">${text}</em>`
	}
	return text
}

/** Inline content of a block child, looking through one nested paragraph. */
function renderBlockChild(child: any): string {
	if (child?.type === 'paragraph')
		return childrenOf(child).map(renderInline).join('')
	return renderInline(child)
}

/**
 * Renders CMS Lexical content to HTML for `set:html`. Every text value is
 * escaped, link targets must pass `isSafeHref`, and the heading tag is limited
 * to h2-h6: the content is stored by CMS editors and shown to every visitor, so
 * it must never reach the page as markup.
 */
export const renderLexicalContent = (content: any) => {
	const blocks = content?.root?.children
	if (!Array.isArray(blocks)) return ''

	return blocks
		.map((node: any) => {
			if (!node || typeof node !== 'object') return ''
			if (node.type === 'paragraph' && node.children) {
				const text = childrenOf(node).map(renderInline).join('')
				return `<p class="mb-4 text-[16px] leading-relaxed text-muted-foreground">${text}</p>`
			}
			if (node.type === 'heading' && node.children) {
				const text = childrenOf(node).map(renderInline).join('')
				const tag = headingTag(node.tag)
				return `<${tag} class="${HEADING_CLASSES[tag]}">${text}</${tag}>`
			}
			if (node.type === 'list' && node.children) {
				const listItems = childrenOf(node)
					.map((item: any) => {
						if (item?.type === 'listitem' && item.children) {
							const itemText = childrenOf(item).map(renderBlockChild).join('')
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
				const text = childrenOf(node).map(renderBlockChild).join('')
				return `<blockquote class="my-6 rounded-2xl bg-brand-soft/40 p-5 text-[16px] italic text-foreground">"${text}"</blockquote>`
			}
			return ''
		})
		.join('')
}
