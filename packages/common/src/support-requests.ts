import { z } from 'zod'

/**
 * Support requests (#233, #406): the shapes shared by the App and Admin. A
 * request is a `Feedback` record with a `kind` of `support` or `problem`, a
 * status, a reply thread and a read time per side. Nothing here carries a
 * guest's name, phone, email or order: the context is an allowlist of ids and a
 * page path, and what the sender types is the only free text.
 */

export const SUPPORT_REQUEST_KINDS = ['support', 'problem'] as const
export type SupportRequestKind = (typeof SUPPORT_REQUEST_KINDS)[number]

export const FEEDBACK_KINDS = ['feedback', ...SUPPORT_REQUEST_KINDS] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

export const SUPPORT_REQUEST_STATUSES = [
	'open',
	'waiting_on_you',
	'closed',
] as const
export type SupportRequestStatus = (typeof SUPPORT_REQUEST_STATUSES)[number]

export type SupportSide = 'member' | 'support'

export const SUPPORT_MESSAGE_MAX = 5000
export const SUPPORT_SUBJECT_MAX = 120
/** Requests one member may send in the window below. */
export const SUPPORT_REQUESTS_PER_HOUR = 5
export const SUPPORT_REPLIES_PER_HOUR = 20
export const SUPPORT_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024
export const SUPPORT_SCREENSHOT_TYPES = [
	'image/png',
	'image/jpeg',
	'image/webp',
] as const

/**
 * The only keys the page context may carry. A test asserts this list, so a new
 * key is a deliberate change. It names where the person was, never who they
 * were serving.
 */
export const SUPPORT_CONTEXT_KEYS = [
	'organizationId',
	'organizationSlug',
	'locationId',
	'path',
	'appVersion',
	'errorId',
] as const
export type SupportContextKey = (typeof SUPPORT_CONTEXT_KEYS)[number]

const ID = z.string().trim().min(1).max(64)

export const supportContextSchema = z.strictObject({
	organizationId: ID,
	organizationSlug: z.string().trim().min(1).max(80).optional(),
	locationId: ID.optional(),
	path: z.string().trim().max(300).optional(),
	appVersion: z.string().trim().min(1).max(60).optional(),
	errorId: z
		.string()
		.trim()
		.regex(/^[a-f0-9]{16}$/)
		.optional(),
})
export type SupportContext = z.infer<typeof supportContextSchema>

/**
 * The page path without its query string and fragment: a search box or a
 * filter can put a guest's name or number in the query, and a fragment can hold
 * a capability token. Only the pathname is kept, bounded in length.
 */
export function sanitizeSupportPath(value: string | null | undefined): string {
	if (!value) return ''
	let pathname = value
	try {
		pathname = new URL(value, 'https://app.invalid').pathname
	} catch {
		pathname = value.split(/[?#]/)[0] ?? ''
	}
	return pathname.slice(0, 300)
}

export function buildSupportContext(input: {
	organizationId: string
	organizationSlug?: string | null
	locationId?: string | null
	path?: string | null
	appVersion?: string | null
	errorId?: string | null
}): SupportContext {
	const path = sanitizeSupportPath(input.path)
	return supportContextSchema.parse({
		organizationId: input.organizationId,
		...(input.organizationSlug && { organizationSlug: input.organizationSlug }),
		...(input.locationId && { locationId: input.locationId }),
		...(path && { path }),
		...(input.appVersion && { appVersion: input.appVersion }),
		...(input.errorId && { errorId: input.errorId }),
	})
}

/** Reads a stored context back, keeping only allowlisted keys. */
export function parseStoredSupportContext(
	raw: string | null | undefined,
): Partial<SupportContext> {
	if (!raw) return {}
	try {
		const value: unknown = JSON.parse(raw)
		if (!value || typeof value !== 'object') return {}
		const picked: Record<string, unknown> = {}
		for (const key of SUPPORT_CONTEXT_KEYS) {
			const entry = (value as Record<string, unknown>)[key]
			if (typeof entry === 'string') picked[key] = entry
		}
		return picked as Partial<SupportContext>
	} catch {
		return {}
	}
}

export const createSupportRequestSchema = z.strictObject({
	kind: z.enum(SUPPORT_REQUEST_KINDS),
	subject: z.string().trim().max(SUPPORT_SUBJECT_MAX).optional(),
	message: z
		.string()
		.trim()
		.min(1, 'Write a message')
		.max(SUPPORT_MESSAGE_MAX, 'The message is too long'),
	/** The page the person was on. Sent by the browser, cut to its path here. */
	path: z.string().trim().max(1000).optional(),
	errorId: z.string().trim().max(32).optional(),
	organizationSlug: z.string().trim().min(1).max(80),
})

export const replySchema = z.strictObject({
	message: z.string().trim().min(1, 'Write a message').max(SUPPORT_MESSAGE_MAX),
})

/** The status after someone writes: support writing waits on the member and the other way round. */
export function statusAfterMessage(
	side: SupportSide,
	current: SupportRequestStatus,
): SupportRequestStatus {
	if (current === 'closed') return side === 'member' ? 'open' : 'closed'
	return side === 'support' ? 'waiting_on_you' : 'open'
}

type ReadState = {
	kind: string
	status: string
	lastMessageAt: Date | number | null
	lastMessageSide: string | null
	memberReadAt: Date | number | null
	supportReadAt: Date | number | null
}

const at = (value: Date | number | null) =>
	value === null ? null : value instanceof Date ? value.getTime() : value

/** Whether the other side wrote after `side` last read the thread. */
export function isUnreadFor(side: SupportSide, row: ReadState): boolean {
	if (row.kind === 'feedback') return false
	const last = at(row.lastMessageAt)
	if (last === null || row.lastMessageSide === side) return false
	const readAt = at(side === 'member' ? row.memberReadAt : row.supportReadAt)
	return readAt === null || readAt < last
}

export const SUPPORT_STATUS_LABELS: Record<SupportRequestStatus, string> = {
	open: 'Open',
	waiting_on_you: 'Waiting on you',
	closed: 'Closed',
}
