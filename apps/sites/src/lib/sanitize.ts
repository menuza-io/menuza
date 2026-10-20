import { JOB_DESCRIPTION_SANITIZE_OPTIONS } from '@repo/common/job-posting'
import sanitizeHtml, { type IOptions } from 'sanitize-html'

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

/**
 * A job description, cleaned again at render time with the same allow-list the
 * App applies when it is saved, so a row edited out of band still cannot carry
 * a script, an image, an inline style or a `javascript:` link.
 */
export function sanitizeJobDescription(html?: string | null): string {
	if (!html) return ''
	return sanitizeHtml(html, JOB_DESCRIPTION_SANITIZE_OPTIONS as IOptions)
}
