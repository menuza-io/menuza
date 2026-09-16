import sanitizeHtml from 'sanitize-html'

export function sanitizeContentBody(html?: string | null): string {
	if (!html) return ''
	return sanitizeHtml(html, {
		allowedTags: [
			'b',
			'i',
			'em',
			'strong',
			'a',
			'p',
			'br',
			'ul',
			'ol',
			'li',
			'h1',
			'h2',
			'h3',
			'h4',
			'h5',
			'h6',
			'blockquote',
			'code',
			'pre',
			'hr',
			'span',
		],
		allowedAttributes: {
			a: ['href', 'name', 'target', 'rel'],
			span: ['class'],
		},
		allowedSchemes: ['http', 'https', 'mailto', 'tel'],
	})
}
