/**
 * Shared by the Workers dev capture (`workers/dev-email-capture.ts`) and the
 * `mock-email+` routes. Dev only: the table is created lazily in the local D1
 * and never exists in a deployed database.
 */
export const RESEND_EMAILS_URL = 'https://api.resend.com/emails'

export const DEV_EMAIL_CAPTURE_TABLE = '__dev_email_capture'

export const DEV_EMAIL_CAPTURE_CREATE_SQL = `CREATE TABLE IF NOT EXISTS ${DEV_EMAIL_CAPTURE_TABLE} (
	id TEXT PRIMARY KEY NOT NULL,
	captured_at INTEGER NOT NULL,
	to_addr TEXT NOT NULL,
	from_addr TEXT NOT NULL,
	subject TEXT NOT NULL,
	html TEXT NOT NULL,
	text TEXT NOT NULL,
	meta TEXT NOT NULL
)`

export type CapturedEmail = {
	id: string
	capturedAt: string
	source: 'app'
	region: null
	to: string
	from: string
	subject: string
	html: string
	text: string
	meta: Record<string, unknown>
}

export type CapturedEmailRow = {
	id: string
	captured_at: number
	to_addr: string
	from_addr: string
	subject: string
	html: string
	text: string
	meta: string
}

function parseMeta(raw: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(raw)
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

export function toCapturedEmail(row: CapturedEmailRow): CapturedEmail {
	return {
		id: row.id,
		capturedAt: new Date(Number(row.captured_at)).toISOString(),
		source: 'app',
		region: null,
		to: row.to_addr,
		from: row.from_addr,
		subject: row.subject,
		html: row.html,
		text: row.text,
		meta: parseMeta(row.meta),
	}
}

/** Accepts epoch milliseconds or anything `Date` parses; `null` when neither. */
export function parseSince(value: string): number | null {
	const trimmed = value.trim()
	if (!trimmed) return null
	const millis = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed)
	return Number.isFinite(millis) ? millis : null
}

export type ResendPayload = {
	to: string
	from: string
	subject: string
	html: string
	text: string
	meta: Record<string, unknown>
}

/** Normalizes a Resend `POST /emails` body; `null` when it is not an object. */
export function parseResendPayload(body: unknown): ResendPayload | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const raw = body as Record<string, unknown>
	const text = (value: unknown) => (typeof value === 'string' ? value : '')
	const recipients = (Array.isArray(raw.to) ? raw.to : [raw.to])
		.filter((value): value is string => typeof value === 'string')
		.map((value) => value.trim())
		.filter(Boolean)
	const tags = Array.isArray(raw.tags)
		? Object.fromEntries(
				(raw.tags as unknown[])
					.filter(
						(tag): tag is { name: string; value: string } =>
							typeof tag === 'object' &&
							tag !== null &&
							typeof (tag as { name?: unknown }).name === 'string' &&
							typeof (tag as { value?: unknown }).value === 'string',
					)
					.map((tag) => [tag.name, tag.value]),
			)
		: null
	return {
		to: recipients.join(','),
		from: text(raw.from),
		subject: text(raw.subject),
		html: text(raw.html),
		text: text(raw.text),
		meta: tags && Object.keys(tags).length > 0 ? { tags } : {},
	}
}
