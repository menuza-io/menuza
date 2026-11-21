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
	/**
	 * What a marketing text needs (#75, #159), also business data: the time
	 * zone of the first location, each location's own zone, the organization's
	 * public site origin and whether short links are on. Null when the App
	 * did not say (an older App); callers then fall back safely.
	 */
	timeZone: string | null
	locationTimeZones: Record<string, string>
	siteOrigin: string | null
	shortLinksEnabled: boolean
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

function parseZones(value: unknown): Record<string, string> {
	if (!value || typeof value !== 'object') return {}
	const zones: Record<string, string> = {}
	for (const [id, zone] of Object.entries(value as Record<string, unknown>)) {
		if (typeof zone === 'string' && zone.length < 64) zones[id] = zone
	}
	return zones
}

/** Whether the App is reachable at all (false in a bare local run). */
export function isOrgLookupConfigured() {
	return Boolean(appBaseUrl()) && getInternalCommandToken().length >= 16
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
			timeZone?: unknown
			locationTimeZones?: unknown
			siteOrigin?: unknown
			features?: { shortLinks?: unknown } | null
		}
		if (body.id !== orgId) return cached ?? null
		const value: OrgEmailSender = {
			organizationName: typeof body.name === 'string' ? body.name : null,
			identity: parseIdentity(body.emailSender),
			timeZone: typeof body.timeZone === 'string' ? body.timeZone : null,
			locationTimeZones: parseZones(body.locationTimeZones),
			siteOrigin:
				typeof body.siteOrigin === 'string' &&
				/^https?:\/\//.test(body.siteOrigin)
					? body.siteOrigin.replace(/\/$/u, '')
					: null,
			shortLinksEnabled: body.features?.shortLinks === true,
		}
		cache.set(orgId, value)
		expiry.set(orgId, Date.now() + ORG_SENDER_TTL_MS)
		return value
	} catch {
		// Stale is better than none; none means the platform sender.
		return cached ?? null
	}
}
