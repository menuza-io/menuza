/** Mention token stored in message bodies: `@[Display Name](user:userId)` */
export const CHAT_MENTION_RE = /@\[([^\]]+)\]\(user:([^)]+)\)/g

const MENTION_LABEL_MAX = 200
const MENTION_ID_MAX = 128

export function chatMentionMarkdown(label: string, userId: string) {
	const safeLabel = label.replace(/\]/g, '').trim() || 'Member'
	return `@[${safeLabel}](user:${userId})`
}

function readAttrValue(fragment: string, name: string): string | null {
	const needle = `${name}="`
	let from = 0
	while (from < fragment.length) {
		const start = fragment.indexOf(needle, from)
		if (start === -1) return null
		if (start > 0 && !/\s/.test(fragment[start - 1]!)) {
			from = start + 1
			continue
		}
		const valueStart = start + needle.length
		let end = valueStart
		while (end < fragment.length && fragment[end] !== '"') end++
		return fragment.slice(valueStart, end)
	}
	return null
}

/** Linear tag strip (avoids regex on user HTML for CodeQL). */
function stripHtmlTags(fragment: string): string {
	let out = ''
	for (let i = 0; i < fragment.length; i++) {
		if (fragment[i] === '<') {
			const close = fragment.indexOf('>', i + 1)
			if (close === -1) {
				out += fragment.slice(i)
				break
			}
			i = close
			continue
		}
		out += fragment[i]
	}
	return out
}

type MentionSpan = { label: string; id: string; start: number; end: number }

function forEachChatMention(
	body: string,
	visit: (mention: MentionSpan) => void,
) {
	let i = 0
	while (i < body.length) {
		if (body[i] !== '@' || body[i + 1] !== '[') {
			i++
			continue
		}
		const labelStart = i + 2
		let j = labelStart
		while (
			j < body.length &&
			body[j] !== ']' &&
			j - labelStart < MENTION_LABEL_MAX
		) {
			j++
		}
		if (j >= body.length || body[j] !== ']') {
			i++
			continue
		}
		const label = body.slice(labelStart, j)
		j++
		if (body.slice(j, j + 6) !== '(user:') {
			i++
			continue
		}
		j += 6
		const idStart = j
		while (j < body.length && body[j] !== ')' && j - idStart < MENTION_ID_MAX) {
			j++
		}
		if (j >= body.length || body[j] !== ')') {
			i++
			continue
		}
		const id = body.slice(idStart, j)
		visit({ label, id, start: i, end: j + 1 })
		i = j + 1
	}
}

function normalizeHtmlMentionSpans(body: string): string {
	const mentionType = 'data-type="mention"'
	const closeToken = '</span>'
	let out = ''
	let cursor = 0
	while (cursor < body.length) {
		const spanStart = body.indexOf('<span', cursor)
		if (spanStart === -1) {
			out += body.slice(cursor)
			break
		}
		out += body.slice(cursor, spanStart)
		const openEnd = body.indexOf('>', spanStart)
		if (openEnd === -1) {
			out += body.slice(spanStart)
			break
		}
		const openTag = body.slice(spanStart, openEnd + 1)
		if (!openTag.includes(mentionType)) {
			out += openTag
			cursor = openEnd + 1
			continue
		}
		const closeStart = body.indexOf(closeToken, openEnd + 1)
		if (closeStart === -1) {
			out += body.slice(spanStart)
			break
		}
		const inner = body.slice(openEnd + 1, closeStart)
		const id = readAttrValue(openTag, 'data-id')
		if (!id) {
			out += body.slice(spanStart, closeStart + closeToken.length)
			cursor = closeStart + closeToken.length
			continue
		}
		const label =
			readAttrValue(openTag, 'data-label') ??
			stripHtmlTags(inner).replace(/^@/, '').trim()
		out += chatMentionMarkdown(label, id)
		cursor = closeStart + closeToken.length
	}
	return out
}

function normalizeInlineMentionTokens(body: string): string {
	const token = '@mention{'
	let out = ''
	let cursor = 0
	while (cursor < body.length) {
		const start = body.indexOf(token, cursor)
		if (start === -1) {
			out += body.slice(cursor)
			break
		}
		out += body.slice(cursor, start)
		const attrsStart = start + token.length
		const attrsEnd = body.indexOf('}', attrsStart)
		if (attrsEnd === -1) {
			out += body.slice(start)
			break
		}
		const attrs = body.slice(attrsStart, attrsEnd)
		const id = readAttrValue(attrs, 'id')
		const label = readAttrValue(attrs, 'label')
		if (!id) {
			out += body.slice(start, attrsEnd + 1)
		} else {
			out += chatMentionMarkdown(label ?? id, id)
		}
		cursor = attrsEnd + 1
	}
	return out
}

/** Map editor / legacy bodies to stored chat markdown (mentions as `@[Name](user:id)`). */
export function normalizeChatMessageBody(body: string) {
	if (!body.includes('mention') && !body.includes('data-type')) {
		return body
	}
	let normalized = body
	if (body.includes('data-type="mention"')) {
		normalized = normalizeHtmlMentionSpans(normalized)
	}
	if (normalized.includes('@mention{')) {
		normalized = normalizeInlineMentionTokens(normalized)
	}
	return normalized
}

export function extractChatMentionUserIds(body: string): string[] {
	const ids: string[] = []
	forEachChatMention(body, ({ id }) => {
		if (id) ids.push(id)
	})
	return [...new Set(ids)]
}

function replaceMarkdownLinksWithText(body: string): string {
	let out = ''
	let i = 0
	while (i < body.length) {
		if (body[i] !== '[') {
			out += body[i]
			i++
			continue
		}
		const labelStart = i + 1
		let j = labelStart
		while (j < body.length && body[j] !== ']' && j - labelStart < 500) j++
		if (j >= body.length || body[j] !== ']' || body[j + 1] !== '(') {
			out += body[i]
			i++
			continue
		}
		const label = body.slice(labelStart, j)
		j += 2
		while (j < body.length && body[j] !== ')') j++
		if (j >= body.length) {
			out += body.slice(i)
			break
		}
		out += label
		i = j + 1
	}
	return out
}

/** Plain-text preview for emails and notifications. */
export function chatBodyPreview(body: string, max = 160) {
	let plain = ''
	let last = 0
	forEachChatMention(body, ({ label, start, end }) => {
		plain += body.slice(last, start)
		plain += `@${label}`
		last = end
	})
	plain += body.slice(last)
	plain = replaceMarkdownLinksWithText(plain)
		.replace(/[*_`>#]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	if (plain.length <= max) return plain
	return `${plain.slice(0, max - 1)}…`
}
