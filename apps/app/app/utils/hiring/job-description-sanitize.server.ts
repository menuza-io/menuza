import { JOB_DESCRIPTION_SANITIZE_OPTIONS } from '@repo/common/job-posting'
import sanitizeHtml, { type IOptions } from 'sanitize-html'

/**
 * Sanitizes a job description on write. The same allow-list runs again when
 * Sites renders the page, so a row edited out of band still cannot carry a
 * script, an image, an inline style or a `javascript:` link.
 *
 * It never truncates: cutting HTML mid-tag would leave broken markup, so the
 * caller refuses a description that is too long instead.
 *
 * (The repo sanitizes HTML with `sanitize-html`, which also runs on Workers.
 * DOMPurify needs a DOM, which Workers do not have.)
 */
export function sanitizeJobDescription(html: string | null | undefined) {
	if (!html || typeof html !== 'string') return ''
	return (
		sanitizeHtml(html, JOB_DESCRIPTION_SANITIZE_OPTIONS as IOptions)
			// An editor leaves empty paragraphs behind; they only add space.
			.replace(/<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '')
			.trim()
	)
}
