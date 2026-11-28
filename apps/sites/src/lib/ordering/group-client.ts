import {
	GROUP_TOKEN_HEADER,
	groupJoinedSchema,
	groupViewSchema,
	type GroupJoined,
	type GroupView,
} from '@repo/common/group-orders'

import { OrderRequestError } from './order-client.ts'
import { getAccessToken, getOrgBinding, tenantFetch } from '~/lib/client-auth'

/**
 * Group orders (#170) from the browser, straight to the regional tenant-api
 * (first names are guest data: never Sites SSR). The host starts a group with
 * the customer token; everyone else holds a token of their own, kept in this
 * browser's `localStorage` and sent as `X-Group-Token`. The link's token lives
 * only in the URL fragment (and in the host's own storage, to show the link).
 */

export type GroupSession = {
	groupId: string
	personToken: string
	/** Kept for the host only: the link to share is built from it. */
	shareToken?: string
	isHost?: boolean
}

const sessionKey = (orgId: string) => `menuza_group_${orgId}`

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The group this browser is in for this restaurant, if any. */
export function loadGroupSession(
	orgId: string,
	storage: StorageLike | null = safeLocal(),
): GroupSession | null {
	try {
		const raw = storage?.getItem(sessionKey(orgId))
		if (!raw) return null
		const value: unknown = JSON.parse(raw)
		if (!value || typeof value !== 'object') return null
		const v = value as Record<string, unknown>
		if (typeof v.groupId !== 'string' || typeof v.personToken !== 'string') {
			return null
		}
		return {
			groupId: v.groupId,
			personToken: v.personToken,
			...(typeof v.shareToken === 'string' ? { shareToken: v.shareToken } : {}),
			...(v.isHost === true ? { isHost: true } : {}),
		}
	} catch {
		return null
	}
}

export function saveGroupSession(
	orgId: string,
	session: GroupSession,
	storage: StorageLike | null = safeLocal(),
) {
	try {
		storage?.setItem(sessionKey(orgId), JSON.stringify(session))
	} catch {
		// Private mode: the guest keeps the group until they close the tab.
	}
}

export function clearGroupSession(
	orgId: string,
	storage: StorageLike | null = safeLocal(),
) {
	try {
		storage?.removeItem(sessionKey(orgId))
	} catch {
		// nothing to clear
	}
}

function safeLocal(): StorageLike | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage
	} catch {
		return null
	}
}

function regionalUrl() {
	const url = document.documentElement.dataset.tenantApiUrl
	if (!url) throw new OrderRequestError('region_unavailable', 503)
	return url.replace(/\/$/, '')
}

async function answer(response: Response): Promise<unknown> {
	const value: unknown = await response.json().catch(() => null)
	if (!response.ok) {
		const code =
			value &&
			typeof value === 'object' &&
			'error' in value &&
			typeof value.error === 'string'
				? value.error
				: 'group_failed'
		throw new OrderRequestError(code, response.status, value)
	}
	return value
}

async function send(
	path: string,
	init: {
		method: string
		token?: string | null
		body?: Record<string, unknown>
	},
): Promise<unknown> {
	const binding = getOrgBinding()
	const headers: Record<string, string> = {}
	if (init.token) headers[GROUP_TOKEN_HEADER] = init.token
	let url = `${regionalUrl()}/orders/group${path}`
	let body: string | undefined
	if (init.body) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify({ ...init.body, ...binding })
	} else {
		url += `${path.includes('?') ? '&' : '?'}${new URLSearchParams(binding)}`
	}
	return answer(
		await fetch(url, { method: init.method, headers, body, cache: 'no-store' }),
	)
}

/** The host starts a group: needs the customer token (the region says 401 without). */
export async function createGroup(request: {
	locationId: string
	deadlineAt?: string
	perPersonLimitMinor?: number
	totalLimitMinor?: number
}): Promise<GroupJoined> {
	if (!getAccessToken()) throw new OrderRequestError('signed_out', 401)
	const { session, response } = await tenantFetch('/orders/group', {
		method: 'POST',
		body: JSON.stringify({ ...request, ...getOrgBinding() }),
	})
	if (session === 'signed_out') throw new OrderRequestError('signed_out', 401)
	if (session === 'transient') {
		throw new OrderRequestError('session_unavailable', 503)
	}
	return groupJoinedSchema.parse(await answer(response))
}

export async function readGroup(
	groupId: string,
	token: string,
): Promise<GroupView> {
	return groupViewSchema.parse(
		await send(`/${encodeURIComponent(groupId)}`, { method: 'GET', token }),
	)
}

export async function joinGroup(
	groupId: string,
	shareToken: string,
	firstName: string,
): Promise<GroupJoined> {
	return groupJoinedSchema.parse(
		await send(`/${encodeURIComponent(groupId)}/join`, {
			method: 'POST',
			token: shareToken,
			body: { firstName },
		}),
	)
}

export async function addGroupLine(
	groupId: string,
	token: string,
	line: Record<string, unknown>,
): Promise<GroupView> {
	return groupViewSchema.parse(
		await send(`/${encodeURIComponent(groupId)}/lines`, {
			method: 'POST',
			token,
			body: { line },
		}),
	)
}

export async function removeGroupLine(
	groupId: string,
	token: string,
	lineId: string,
): Promise<GroupView> {
	return groupViewSchema.parse(
		await send(
			`/${encodeURIComponent(groupId)}/lines/${encodeURIComponent(lineId)}`,
			{ method: 'DELETE', token },
		),
	)
}

export async function setGroupDone(
	groupId: string,
	token: string,
	done: boolean,
): Promise<GroupView> {
	return groupViewSchema.parse(
		await send(`/${encodeURIComponent(groupId)}/done`, {
			method: 'POST',
			token,
			body: { done },
		}),
	)
}

export async function updateGroup(
	groupId: string,
	token: string,
	changes: {
		locked?: boolean
		deadlineAt?: string | null
		perPersonLimitMinor?: number | null
		totalLimitMinor?: number | null
	},
): Promise<GroupView> {
	return groupViewSchema.parse(
		await send(`/${encodeURIComponent(groupId)}`, {
			method: 'PATCH',
			token,
			body: changes,
		}),
	)
}

/** The host burns the old link: every earlier link stops working. */
export async function rotateGroupShare(
	groupId: string,
	token: string,
): Promise<{ shareToken: string; view: GroupView }> {
	const answer = (await send(`/${encodeURIComponent(groupId)}/share/rotate`, {
		method: 'POST',
		token,
		body: {},
	})) as { shareToken?: unknown; view?: unknown }
	const shareToken = shareTokenFromHash(`#join=${String(answer.shareToken)}`)
	if (!shareToken) throw new Error('The region sent no new link')
	return { shareToken, view: groupViewSchema.parse(answer.view) }
}

export async function leaveGroup(groupId: string, token: string) {
	await send(`/${encodeURIComponent(groupId)}/people/me`, {
		method: 'DELETE',
		token,
	})
}

export async function endGroup(groupId: string, token: string) {
	await send(`/${encodeURIComponent(groupId)}`, { method: 'DELETE', token })
}

/** The share link: group in the query, the token in the fragment only. */
export function groupShareLink(
	origin: string,
	pagePath: string,
	groupId: string,
	shareToken: string,
): string {
	return `${origin}${pagePath}?g=${encodeURIComponent(groupId)}#join=${shareToken}`
}

/** Where the layout's inline script parks a `#join=` token it moved out of the bar. */
export const PENDING_JOIN_KEY = 'menuza_pending_join'

export function readPendingShareToken(storage: Pick<Storage, 'getItem'>) {
	try {
		const value = storage.getItem(PENDING_JOIN_KEY)
		return value ? shareTokenFromHash(`#join=${value}`) : null
	} catch {
		return null
	}
}

export function clearPendingShareToken(storage: Pick<Storage, 'removeItem'>) {
	try {
		storage.removeItem(PENDING_JOIN_KEY)
	} catch {
		// nothing to clear
	}
}

/** `#join=<token>` from a URL fragment, or null. */
export function shareTokenFromHash(hash: string): string | null {
	const match = /^#?join=(gs1\.[0-9a-f]{64})$/.exec(hash)
	return match ? match[1]! : null
}
