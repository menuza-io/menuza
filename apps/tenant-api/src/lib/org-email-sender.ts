import { LRUCache } from 'lru-cache'
import { ENV } from 'varlock/env'
import { type OrganizationEmailIdentity } from '@repo/common/email-sender'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { fetchApp } from './app-service.ts'
import { getInternalCommandToken } from './secrets.ts'

/**
 * The sender settings of an organization (#103), read from the organization
 * metadata the App already serves to this node. They are business identity
 * (a name, a verified reply-to, a verified sending address), never guest data.
 * Cached for a minute; a lookup that fails never fails a send: the message
 * goes out from the platform address, as before.
 */

export type OrgEmailSender = {
	organizationName: string | null
	identity: OrganizationEmailIdentity | null
}

export const ORG_SENDER_TTL_MS = 60_000
const LOOKUP_TIMEOUT_MS = 3_000

const cache = new LRUCache<string, OrgEmailSender>({ max: 1000 })
const expiry = new Map<string, number>()

export function clearOrgEmailSenderCacheForTest() {
	cache.clear()
	expiry.clear()
}

function appBaseUrl() {
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/u,
		'',
	)
}

function parseIdentity(value: unknown): OrganizationEmailIdentity | null {
	if (!value || typeof value !== 'object') return null
	const raw = value as Record<string, unknown>
	const text = (key: string) =>
		typeof raw[key] === 'string' && (raw[key] as string).length > 0
			? (raw[key] as string)
			: null
	return {
		senderName: text('senderName'),
		replyTo: text('replyTo'),
		fromEmail: text('fromEmail'),
	}
}

export async function getOrgEmailSender(
	orgId: string,
): Promise<OrgEmailSender | null> {
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) return null
	const cached = cache.get(orgId)
	const fresh = (expiry.get(orgId) ?? 0) > Date.now()
	if (cached && fresh) return cached

	const appUrl = appBaseUrl()
	const token = getInternalCommandToken()
	if (!appUrl || token.length < 16) return cached ?? null
	try {
		const response = await fetchApp(
			`${appUrl}/resources/tenant-organization?${new URLSearchParams({ orgId })}`,
			{
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${token}`,
				},
				signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
			},
		)
		if (!response.ok) return cached ?? null
		const body = (await response.json()) as {
			id?: string
			name?: string | null
			emailSender?: unknown
		}
		if (body.id !== orgId) return cached ?? null
		const value: OrgEmailSender = {
			organizationName: typeof body.name === 'string' ? body.name : null,
			identity: parseIdentity(body.emailSender),
		}
		cache.set(orgId, value)
		expiry.set(orgId, Date.now() + ORG_SENDER_TTL_MS)
		return value
	} catch {
		// Stale is better than none; none means the platform sender.
		return cached ?? null
	}
}
