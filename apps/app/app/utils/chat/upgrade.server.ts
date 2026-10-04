import {
	getUserId,
	ORG_PERMISSIONS,
	userHasOrganizationPermission,
} from '@repo/auth'
import { getUserImgSrc } from '@repo/common'
import { and, db, eq, Organization, User, UserImage } from '@repo/database'
import { isActiveOrganizationMember } from './audience.server.ts'
import { listChannelsForUser } from './channels.server.ts'
import { CHAT_HEADERS, chatOrgStub } from './namespace.server.ts'

const CHAT_PATH = /^\/([^/]+)\/chat\/ws$/
const CHAT_UNREAD_PATH = /^\/([^/]+)\/chat\/unread$/

/**
 * Authenticates a chat WebSocket upgrade and hands it to the organization's
 * Durable Object. Returns `null` when the request is not a chat upgrade so the
 * caller can fall through to the normal request handler.
 *
 * The Durable Object trusts the `x-chat-*` headers set here, so every one of
 * them is overwritten (never forwarded) and the DO is reachable only through
 * this Worker's binding.
 */
export async function handleChatRequest(
	request: Request,
): Promise<Response | null> {
	const unread = await handleChatUnread(request)
	if (unread) return unread
	return handleChatUpgrade(request)
}

export async function handleChatUpgrade(
	request: Request,
): Promise<Response | null> {
	const url = new URL(request.url)
	const match = CHAT_PATH.exec(url.pathname)
	if (!match) return null

	if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
		return new Response('Expected a WebSocket upgrade', { status: 426 })
	}
	// Browsers always send Origin on WebSocket handshakes and cookies ride along
	// automatically, so without this a malicious page could open a socket as the
	// signed-in user (cross-site WebSocket hijacking).
	const origin = request.headers.get('Origin')
	// `dev-proxy.js` sets `changeOrigin` so the upstream Host is localhost while
	// the browser Origin stays on app.{brand}.test:2999.
	const requestHost =
		request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ?? url.host
	if (!origin || safeHost(origin) !== requestHost) {
		return new Response('Forbidden', { status: 403 })
	}

	const userId = await getUserId(request)
	if (!userId) return new Response('Unauthorized', { status: 401 })

	const orgSlug = decodeURIComponent(match[1]!)
	const [organization] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(and(eq(Organization.slug, orgSlug), eq(Organization.active, true)))
		.limit(1)
	// Same response whether the org is missing or the user is not in it.
	if (
		!organization ||
		!(await isActiveOrganizationMember(organization.id, userId))
	) {
		return new Response('Forbidden', { status: 403 })
	}

	const stub = chatOrgStub(organization.id)
	if (!stub) return new Response('Chat is unavailable', { status: 503 })

	const [canModerate, [user]] = await Promise.all([
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.UPDATE_CHAT_ANY,
		),
		db
			.select({
				name: User.name,
				username: User.username,
				imageKey: UserImage.objectKey,
			})
			.from(User)
			.leftJoin(UserImage, eq(UserImage.userId, User.id))
			.where(eq(User.id, userId))
			.limit(1),
	])
	if (!user) return new Response('Unauthorized', { status: 401 })

	const headers = new Headers(request.headers)
	for (const name of [...headers.keys()]) {
		if (name.startsWith('x-chat-')) headers.delete(name)
	}
	headers.set(CHAT_HEADERS.org, organization.id)
	headers.set(CHAT_HEADERS.user, userId)
	headers.set(CHAT_HEADERS.moderator, canModerate ? '1' : '0')
	headers.set(
		CHAT_HEADERS.name,
		encodeURIComponent((user.name?.trim() || user.username).slice(0, 100)),
	)
	headers.set(
		CHAT_HEADERS.image,
		user.imageKey ? encodeURIComponent(getUserImgSrc(user.imageKey)) : '',
	)
	return stub.fetch(new Request(request, { headers }))
}

function safeHost(origin: string) {
	try {
		return new URL(origin).host
	} catch {
		return null
	}
}

async function handleChatUnread(request: Request): Promise<Response | null> {
	if (request.method !== 'GET') return null
	const url = new URL(request.url)
	const match = CHAT_UNREAD_PATH.exec(url.pathname)
	if (!match) return null

	const userId = await getUserId(request)
	if (!userId) return new Response('Unauthorized', { status: 401 })

	const orgSlug = decodeURIComponent(match[1]!)
	const [organization] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(and(eq(Organization.slug, orgSlug), eq(Organization.active, true)))
		.limit(1)
	if (
		!organization ||
		!(await isActiveOrganizationMember(organization.id, userId))
	) {
		return new Response('Forbidden', { status: 403 })
	}

	const stub = chatOrgStub(organization.id)
	if (!stub) return new Response('Chat is unavailable', { status: 503 })

	const channels = await listChannelsForUser(organization.id, userId)
	const channelIds = channels.map((channel) => channel.id)
	const response = await stub.fetch(
		new Request('https://chat.internal/rpc/unread', {
			method: 'GET',
			headers: {
				[CHAT_HEADERS.user]: userId,
				'x-chat-channels': JSON.stringify(channelIds),
			},
		}),
	)
	return response
}
