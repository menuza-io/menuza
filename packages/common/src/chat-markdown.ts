/** Mention token stored in message bodies: `@[Display Name](user:userId)` */
export const CHAT_MENTION_RE = /@\[([^\]]+)\]\(user:([^)]+)\)/g

export function chatMentionMarkdown(label: string, userId: string) {
	const safeLabel = label.replace(/\]/g, '').trim() || 'Member'
	return `@[${safeLabel}](user:${userId})`
}

const HTML_MENTION_SPAN_RE =
	/<span\b(?=[^>]*\bdata-type="mention")[^>]*>[\s\S]*?<\/span>/gi

const INLINE_MENTION_MD_RE = /@mention\{([^}]*)\}/g

/** Map editor / legacy bodies to stored chat markdown (mentions as `@[Name](user:id)`). */
export function normalizeChatMessageBody(body: string) {
	if (!body.includes('mention') && !body.includes('data-type')) {
		return body
	}
	let normalized = body.replace(HTML_MENTION_SPAN_RE, (span) => {
		const id = /data-id="([^"]*)"/i.exec(span)?.[1]
		if (!id) return span
		const label =
			/data-label="([^"]*)"/i.exec(span)?.[1] ??
			span
				.replace(/<[^>]+>/g, '')
				.replace(/^@/, '')
				.trim()
		return chatMentionMarkdown(label, id)
	})
	normalized = normalized.replace(INLINE_MENTION_MD_RE, (match, attrs) => {
		const id = /(?:^|\s)id="([^"]*)"/.exec(attrs)?.[1]
		const label = /(?:^|\s)label="([^"]*)"/.exec(attrs)?.[1]
		if (!id) return match
		return chatMentionMarkdown(label ?? id, id)
	})
	return normalized
}

export function extractChatMentionUserIds(body: string): string[] {
	const ids: string[] = []
	for (const match of body.matchAll(CHAT_MENTION_RE)) {
		const id = match[2]
		if (id) ids.push(id)
	}
	return [...new Set(ids)]
}

/** Plain-text preview for emails and notifications. */
export function chatBodyPreview(body: string, max = 160) {
	const plain = body
		.replace(CHAT_MENTION_RE, (_, label: string) => `@${label}`)
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/[*_`>#]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	if (plain.length <= max) return plain
	return `${plain.slice(0, max - 1)}…`
}
