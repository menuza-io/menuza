import { invariant, invariantResponse } from '@epic-web/invariant'
import { convertToModelMessages, type ModelMessage } from 'ai'
import { type ActionFunctionArgs } from 'react-router'
import {
	NoteAccess,
	NoteComment,
	OrganizationNote,
	User,
	db,
	eq,
} from '@repo/database'

export type WebsitePageSectionContext = {
	id: string
	type: string
	position: number
	config?: string
}

export type WebsitePageListItem = {
	id: string
	title: string
	slug: string
	isHomePage: boolean
	sections: WebsitePageSectionContext[]
}

export type PageEditorPromptContext = {
	pages: WebsitePageListItem[]
	currentPageId: string | null
	currentPage: {
		id: string
		title: string
		slug: string
		isHomePage?: boolean
		sections: WebsitePageSectionContext[]
	} | null
}

export type AppLocationContext = {
	currentPath: string | null
	orgSlug: string | null
	params: Record<string, string>
}

export type NavigableAppRoute = {
	id: string
	title: string
	aliases?: string[]
	description: string
	path: string
}

export interface ChatDependencies {
	requireUserId: (request: Request) => Promise<string>
	/**
	 * Must verify the user is an active member of the given organization.
	 * Throw a 403 Response if not. Matches the same permission check used
	 * by the note detail loader (READ_NOTE_OWN).
	 */
	requireOrgMembership: (
		request: Request,
		organizationId: string,
	) => Promise<unknown>
	createChatStream: (params: {
		messages: ModelMessage[]
		systemPrompt: string
		tools?: Record<string, any>
	}) => any
	buildNoteChatSystemPrompt: (basePrompt: string, noteContext: any) => string
	buildPageEditorSystemPrompt?: (
		basePrompt: string,
		pageContext: PageEditorPromptContext,
	) => string
	brandSystemPrompt: string
	getPageEditorTools?: (ctx: { organizationId: string }) => Record<string, any>
	getNavigationTools?: () => Record<string, any>
	getNavigableRoutes?: (ctx: { orgSlug: string | null }) => NavigableAppRoute[]
	buildNavigationSystemPrompt?: (
		basePrompt: string,
		ctx: { location: AppLocationContext; routes: NavigableAppRoute[] },
	) => string
	hasWebsiteAccess?: (
		request: Request,
		organizationId: string,
	) => Promise<boolean>
	getPageContext?: (
		pageId: string,
		organizationId: string,
	) => Promise<PageEditorPromptContext['currentPage']>
	getWebsitePages?: (organizationId: string) => Promise<WebsitePageListItem[]>
	resolveOrganizationFromSlug?: (
		request: Request,
		orgSlug: string,
	) => Promise<{ id: string }>
	markStepCompleted?: (
		userId: string,
		organizationId: string,
		stepKey: string,
		options: any,
	) => Promise<void>
}

/** Limits on images attached to a chat message. The client downsizes them and
 *  keeps only the last few in a request, so these only stop a request that
 *  skipped the client. */
export const MAX_CHAT_IMAGES = 12
export const MAX_CHAT_IMAGES_PER_MESSAGE = 4
export const MAX_CHAT_IMAGE_URL_LENGTH = 3_000_000

const INLINE_IMAGE_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,/
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/
/** Largest request body read at all: the image caps plus room for the text. */
export const MAX_CHAT_BODY_BYTES = 40_000_000

/**
 * Reads the request body as text, giving up as soon as more than `maxBytes`
 * have arrived (and cancelling the rest), so an oversized or unannounced body
 * is never held in memory whole. Returns null when the limit is exceeded.
 */
async function readTextWithLimit(
	request: Request,
	maxBytes: number,
): Promise<string | null> {
	const reader = request.body?.getReader()
	if (!reader) return ''
	// Decode each chunk as it arrives so the raw bytes can be freed, and join
	// once at the end. Holding every chunk and then copying them into one
	// buffer would keep the body three times over at its peak (chunks, buffer,
	// string), which matters in a 128 MB Worker isolate.
	const decoder = new TextDecoder()
	const parts: string[] = []
	let received = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		received += value.byteLength
		if (received > maxBytes) {
			await reader.cancel()
			return null
		}
		parts.push(decoder.decode(value, { stream: true }))
	}
	parts.push(decoder.decode())
	return parts.join('')
}

/**
 * Whether the first bytes of the decoded data are those of the declared type.
 * A content guard only: it rejects payloads that are plainly not an image, but
 * a valid header followed by anything passes. The model provider validates the
 * image itself.
 */
function hasImageSignature(mediaType: string, base64: string): boolean {
	let bytes: Uint8Array
	try {
		// 24 characters decode to 18 bytes, enough for every signature below.
		const head = base64.slice(0, 24)
		bytes = Uint8Array.from(
			atob(head.padEnd(Math.ceil(head.length / 4) * 4, '=')),
			(c) => c.charCodeAt(0),
		)
	} catch {
		return false
	}
	const at = (index: number) => bytes[index] ?? -1
	switch (mediaType) {
		case 'image/png':
			return (
				at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47
			)
		case 'image/jpeg':
			return at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff
		case 'image/gif':
			return (
				at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38
			)
		case 'image/webp':
			return (
				at(0) === 0x52 &&
				at(1) === 0x49 &&
				at(2) === 0x46 &&
				at(3) === 0x46 &&
				at(8) === 0x57 &&
				at(9) === 0x45 &&
				at(10) === 0x42 &&
				at(11) === 0x50
			)
		default:
			return false
	}
}

/**
 * Checks every file part and returns a refusal for anything that is not a
 * small, inline, base64 PNG/JPEG/WebP/GIF that starts with the signature of its
 * declared type (see `hasImageSignature`: this is not full image validation).
 * A remote URL would make the server fetch whatever the client names, and a
 * provider reference would make the model use something other than the bytes
 * that were checked.
 *
 * It also CHANGES `rawMessages`: each accepted part is replaced by one rebuilt
 * from the known fields only, so nothing else the client attached reaches the
 * model.
 */
export function sanitizeChatAttachments(rawMessages: unknown): Response | null {
	if (!Array.isArray(rawMessages)) {
		return new Response('Invalid messages', { status: 400 })
	}
	let images = 0
	for (const message of rawMessages) {
		const parts = (message as { parts?: unknown })?.parts
		if (!Array.isArray(parts)) continue
		let inMessage = 0
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index] as Record<string, unknown> | null
			if (part?.type !== 'file') continue
			const { url, mediaType, filename } = part
			const match = typeof url === 'string' ? INLINE_IMAGE_URL.exec(url) : null
			if (!match || typeof mediaType !== 'string' || mediaType !== match[1]) {
				return new Response('Only images can be attached', { status: 400 })
			}
			const urlText = url as string
			if (urlText.length > MAX_CHAT_IMAGE_URL_LENGTH) {
				return new Response('That image is too large', { status: 413 })
			}
			const payload = urlText.slice(match[0].length)
			if (
				!BASE64_BODY.test(payload) ||
				!hasImageSignature(mediaType, payload)
			) {
				return new Response('Only images can be attached', { status: 400 })
			}
			inMessage += 1
			images += 1
			if (inMessage > MAX_CHAT_IMAGES_PER_MESSAGE || images > MAX_CHAT_IMAGES) {
				return new Response('Too many images', { status: 413 })
			}
			parts[index] = {
				type: 'file',
				mediaType,
				url,
				...(typeof filename === 'string'
					? { filename: filename.slice(0, 200) }
					: {}),
			}
		}
	}
	return null
}

async function convertIncomingMessages(
	rawMessages: unknown[],
	tools?: Record<string, any>,
): Promise<ModelMessage[]> {
	return convertToModelMessages(
		rawMessages as any,
		tools ? { tools } : undefined,
	)
}

function sanitizeCurrentPath(value: unknown): string | null {
	if (typeof value !== 'string') return null
	if (!value.startsWith('/') || value.includes('://') || value.length > 500) {
		return null
	}
	return value
}

function sanitizeRouteParams(value: unknown): Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	const result: Record<string, string> = {}
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key)) continue
		if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) {
			continue
		}
		result[key] = raw
		if (Object.keys(result).length >= 20) break
	}
	return result
}

function parseAppLocation(
	body: {
		currentPath?: unknown
		params?: unknown
	},
	orgSlugFromUrl: string | null,
): AppLocationContext {
	const params = sanitizeRouteParams(body.params)
	const orgSlug = orgSlugFromUrl || params.orgSlug || null
	return {
		currentPath: sanitizeCurrentPath(body.currentPath),
		orgSlug,
		params,
	}
}

/** Website CMS tools bloat the prompt; only attach them in the page editor or website section. */
export function shouldAttachWebsiteEditorContext(
	location: AppLocationContext,
	pageId: string | null,
): boolean {
	if (pageId) return true
	const path = location.currentPath
	if (!path) return false
	return /\/website(?:\/|$)/.test(path)
}

function toChatStreamResponse(result: {
	toUIMessageStreamResponse?: () => Response
	toDataStreamResponse?: () => Response
}) {
	if (typeof result.toUIMessageStreamResponse === 'function') {
		return result.toUIMessageStreamResponse()
	}
	if (typeof result.toDataStreamResponse === 'function') {
		return result.toDataStreamResponse()
	}
	throw new Error('Chat stream result is missing a response converter')
}

/**
 * Shared handler for AI chat streaming.
 * Used by both the admin and app applications.
 *
 * @param request - The incoming request
 * @param deps - Dependencies (auth, AI utilities)
 * @returns Streaming response
 */
export async function handleChat(
	{ request }: ActionFunctionArgs,
	deps: ChatDependencies,
) {
	if (request.method !== 'POST') {
		throw new Response('Method not allowed', { status: 405 })
	}

	const userId = await deps.requireUserId(request)
	const url = new URL(request.url)
	const noteId = url.searchParams.get('noteId')
	const orgSlug = url.searchParams.get('orgSlug')

	// Read the body with a real limit. The Content-Length header is only a hint
	// (it can be missing, chunked or understated), so it is checked first for a
	// cheap refusal and the bytes are counted as they arrive either way.
	const declaredLength = Number(request.headers.get('content-length'))
	if (declaredLength > MAX_CHAT_BODY_BYTES) {
		return new Response('Request too large', { status: 413 })
	}
	const text = await readTextWithLimit(request, MAX_CHAT_BODY_BYTES)
	if (text === null) return new Response('Request too large', { status: 413 })
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return new Response('Invalid JSON', { status: 400 })
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return new Response('Invalid JSON', { status: 400 })
	}
	const body = parsed as {
		messages: unknown[]
		pageId?: string | null
		currentPath?: unknown
		params?: unknown
	}
	const { messages: rawMessages } = body
	const attachmentRefusal = sanitizeChatAttachments(rawMessages)
	if (attachmentRefusal) return attachmentRefusal
	const pageId = url.searchParams.get('pageId') ?? body.pageId ?? null

	// When noteId is absent, attach app-navigation tools plus (when allowed)
	// website editor tools. Missing website permission still keeps navigation.
	if (!noteId) {
		const location = parseAppLocation(body, orgSlug)
		const navigationTools = deps.getNavigationTools?.() ?? {}
		let tools: Record<string, any> = { ...navigationTools }
		let systemPrompt = deps.brandSystemPrompt
		const routes =
			deps.getNavigableRoutes?.({ orgSlug: location.orgSlug }) ?? []
		if (deps.buildNavigationSystemPrompt && routes.length > 0) {
			systemPrompt = deps.buildNavigationSystemPrompt(systemPrompt, {
				location,
				routes,
			})
		}

		if (location.orgSlug && deps.resolveOrganizationFromSlug) {
			try {
				const organization = await deps.resolveOrganizationFromSlug(
					request,
					location.orgSlug,
				)
				const hasWebsiteAccess = deps.hasWebsiteAccess
					? await deps.hasWebsiteAccess(request, organization.id)
					: Boolean(deps.getPageEditorTools)

				if (
					hasWebsiteAccess &&
					deps.getPageEditorTools &&
					shouldAttachWebsiteEditorContext(location, pageId)
				) {
					const pages = deps.getWebsitePages
						? await deps.getWebsitePages(organization.id)
						: []
					const currentPage =
						pageId && deps.getPageContext
							? await deps.getPageContext(pageId, organization.id)
							: (pages.find((page) => page.id === pageId) ?? null)
					const pageContext: PageEditorPromptContext = {
						pages,
						currentPageId: pageId,
						currentPage,
					}
					systemPrompt = deps.buildPageEditorSystemPrompt
						? deps.buildPageEditorSystemPrompt(systemPrompt, pageContext)
						: systemPrompt +
							'\n\nYou are helping the user edit their website pages.'
					const pageEditorTools = deps.getPageEditorTools({
						organizationId: organization.id,
					})
					tools =
						Object.keys(tools).length > 0
							? { ...tools, ...pageEditorTools }
							: pageEditorTools
				}
			} catch (error) {
				if (
					!(error instanceof Response) ||
					(error.status !== 403 && error.status !== 404)
				) {
					throw error
				}
			}
		}

		const hasTools = Object.keys(tools).length > 0
		const messages = await convertIncomingMessages(
			rawMessages,
			hasTools ? tools : undefined,
		)
		const result = deps.createChatStream({
			messages,
			systemPrompt,
			...(hasTools ? { tools } : {}),
		})
		return toChatStreamResponse(result)
	}

	const [noteMeta] = await db
		.select({
			id: OrganizationNote.id,
			organizationId: OrganizationNote.organizationId,
		})
		.from(OrganizationNote)
		.where(eq(OrganizationNote.id, noteId))
		.limit(1)

	if (!noteMeta) {
		invariant(noteMeta, 'Note not found')
	}

	// Enforce org membership before reading note details or comments.
	await deps.requireOrgMembership(request, noteMeta.organizationId)

	const [note, noteAccess, comments] = await Promise.all([
		db
			.select({
				content: OrganizationNote.content,
				title: OrganizationNote.title,
				organizationId: OrganizationNote.organizationId,
				isPublic: OrganizationNote.isPublic,
				createdById: OrganizationNote.createdById,
			})
			.from(OrganizationNote)
			.where(eq(OrganizationNote.id, noteId))
			.limit(1)
			.then((rows) => rows[0]),
		db
			.select({ userId: NoteAccess.userId })
			.from(NoteAccess)
			.where(eq(NoteAccess.noteId, noteId)),
		db
			.select({ content: NoteComment.content, userName: User.name })
			.from(NoteComment)
			.leftJoin(User, eq(NoteComment.userId, User.id))
			.where(eq(NoteComment.noteId, noteId)),
	])

	if (!note) {
		invariant(note, 'Note not found')
	}

	if (!note.isPublic) {
		const hasPersonalAccess =
			note.createdById === userId ||
			noteAccess.some((access) => access.userId === userId)
		invariantResponse(
			hasPersonalAccess,
			'Not authorized - insufficient note permissions',
			{ status: 403 },
		)
	}

	// Track AI chat usage for onboarding (if markStepCompleted is provided)
	if (deps.markStepCompleted) {
		try {
			await deps.markStepCompleted(userId, note.organizationId, 'try_ai_chat', {
				completedVia: 'ai_chat_usage',
				noteId,
			})
		} catch (error) {
			// Don't fail the AI request if onboarding tracking fails
			console.error('Failed to track AI chat onboarding step:', error)
		}
	}

	// Build note context
	const noteContext = {
		title: note.title,
		content: note.content,
		wordCount: note.content ? note.content.split(/\s+/).length : 0,
		hasComments: comments.length > 0,
		commentCount: comments.length,
		comments: comments.map((comment) => ({
			content: comment.content,
			userName: comment.userName,
		})),
	}

	// Build system prompt with note context
	const systemPrompt = deps.buildNoteChatSystemPrompt(
		deps.brandSystemPrompt,
		noteContext,
	)

	// Create streaming chat response
	const result = deps.createChatStream({
		messages: await convertIncomingMessages(rawMessages),
		systemPrompt,
	})

	return toChatStreamResponse(result)
}
