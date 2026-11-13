/**
 * The visible unsubscribe link at the foot of a tenant marketing email. The
 * regional send path fills in the signed link; the designer preview shows the
 * same markup with a placeholder `#` link, so authors see what recipients get.
 */

/** `href` the preview uses in place of a signed link. */
export const UNSUBSCRIBE_PREVIEW_HREF = '#unsubscribe'

function escapeAttribute(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
}

export function unsubscribeFooterHtml(url: string): string {
	return `<p style="font-size:12px;color:#666"><a href="${escapeAttribute(url)}">Unsubscribe</a></p>`
}

/**
 * Adds the unsubscribe link to an email body. A full HTML document (a designed
 * email) gets it just before `</body>`; a fragment gets it appended.
 */
export function withUnsubscribeFooter(html: string, url: string): string {
	const footer = unsubscribeFooterHtml(url)
	const bodyClose = html.toLowerCase().lastIndexOf('</body>')
	if (bodyClose === -1) return `${html}${footer}`
	return `${html.slice(0, bodyClose)}${footer}${html.slice(bodyClose)}`
}
