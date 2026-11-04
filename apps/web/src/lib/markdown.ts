import {
	Lexer,
	marked,
	type Token,
	type TokenizerAndRendererExtension,
	type Tokens,
} from 'marked'

export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

export function isSafeHref(href: string): boolean {
	return /^(https?:\/\/|\/|#|mailto:|tel:)/i.test(href)
}

const highlightExtension: TokenizerAndRendererExtension = {
	name: 'highlight',
	level: 'inline',
	start(src) {
		return src.indexOf('==')
	},
	tokenizer(src) {
		const match = /^==([^=\n]+)==/.exec(src)
		if (!match) return undefined
		return {
			type: 'highlight',
			raw: match[0],
			text: match[1],
		}
	},
	renderer(token) {
		return `<mark class="md-highlight">${escapeHtml(String(token.text))}</mark>`
	},
}

const brandExtension: TokenizerAndRendererExtension = {
	name: 'brand',
	level: 'inline',
	start(src) {
		return src.indexOf('^^')
	},
	tokenizer(src) {
		const match = /^\^\^([^^\n]+)\^\^/.exec(src)
		if (!match) return undefined
		return {
			type: 'brand',
			raw: match[0],
			text: match[1],
		}
	},
	renderer(token) {
		return `<span class="text-brand">${escapeHtml(String(token.text))}</span>`
	},
}

marked.use({
	gfm: true,
	breaks: true,
	renderer: {
		html() {
			return ''
		},
		image() {
			return ''
		},
		link({ href, title, text }: Tokens.Link) {
			if (!href || !isSafeHref(href)) return text
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
			return `<a href="${escapeHtml(href)}" class="underline underline-offset-2"${titleAttr}>${text}</a>`
		},
	},
	extensions: [highlightExtension, brandExtension],
})

/** Syntax editors can use in Emdash title and description fields. */
export const MARKDOWN_SYNTAX_HELP =
	'**bold** · *italic* · ==highlight== · ^^brand color^^ · [link](url)'

export function lexMarkdown(content: string, block = false): Token[] {
	return block ? marked.lexer(content) : Lexer.lexInline(content)
}

export function parseMarkdownInline(content: string): string {
	return marked.parseInline(content, { async: false }) as string
}

export function parseMarkdownBlock(content: string): string {
	return marked.parse(content, { async: false }) as string
}

function tokenPlainText(tokens: Token[] | undefined): string {
	if (!tokens?.length) return ''

	return tokens
		.map((token) => {
			if (token.type === 'html' || token.type === 'image') return ''
			if (token.type === 'br' || token.type === 'space') return ' '
			if (token.type === 'list') {
				const list = token as Tokens.List
				return list.items.map((item) => tokenPlainText(item.tokens)).join(' ')
			}
			if ('tokens' in token && token.tokens?.length) {
				return tokenPlainText(token.tokens)
			}
			if ('text' in token && typeof token.text === 'string') {
				return token.text
			}
			return ''
		})
		.join('')
}

/** Plain text for SEO meta tags, aria labels, and share dialogs. */
export function stripMarkdown(content: string): string {
	return tokenPlainText(marked.lexer(content)).replace(/\s+/g, ' ').trim()
}
