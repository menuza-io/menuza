/**
 * Access to the per-organization chat Durable Objects.
 *
 * The namespace only exists on Cloudflare Workers. The Node-only dev server
 * (`npm run dev:node -w app`) has no binding; `isChatAvailable()` is false and
 * the chat UI shows an "unavailable" state. Default `npm run dev` uses Workers.
 */

/** Headers the Worker sets for the Durable Object after authenticating. */
export const CHAT_HEADERS = {
	org: 'x-chat-org',
	user: 'x-chat-user',
	name: 'x-chat-name',
	image: 'x-chat-image',
	moderator: 'x-chat-moderator',
} as const

/** Control calls the app makes on a chat Durable Object. */
export type ChatOrgControl = {
	evictUser(userId: string): Promise<void>
	invalidate(): Promise<void>
	channelsChanged(): Promise<void>
	deleteChannel(channelId: string): Promise<void>
	runRetentionPrune(): Promise<number>
}

export type ChatOrgStub = ChatOrgControl & {
	fetch(request: Request): Promise<Response>
}

type ChatNamespace = {
	getByName(name: string): ChatOrgStub
}

let namespace: ChatNamespace | null = null

export function bindChatNamespace(binding: unknown) {
	namespace = (binding as ChatNamespace | undefined) ?? null
}

export function isChatAvailable() {
	return namespace !== null
}

export function chatOrgStub(organizationId: string): ChatOrgStub | null {
	return namespace?.getByName(organizationId) ?? null
}

/**
 * Best-effort nudge to a live chat room after an access change. The room also
 * re-checks the database every ~30 seconds, so a failure here only delays
 * revocation; it must never fail the admin action that triggered it.
 */
export async function notifyChat(
	organizationId: string,
	action: (stub: ChatOrgControl) => Promise<void>,
) {
	const stub = chatOrgStub(organizationId)
	if (!stub) return
	try {
		await action(stub)
	} catch (error) {
		console.warn('Chat room notification failed', error)
	}
}
