import { brand } from './brand.js'

export const MARKETING_EMAIL_PLATFORM_SCOPE = 'platform' as const

/** Pre-brand-slug Resend tags (still accepted on webhook ingest). */
export const LEGACY_MARKETING_EMAIL_TAGS = {
	scope: 'epic_scope',
	messageId: 'epic_message_id',
	campaignId: 'epic_campaign_id',
} as const

/** Pre-brand-slug OCI / SMTP headers (still accepted on log ingest). */
export const LEGACY_MARKETING_EMAIL_HEADERS = {
	orgId: 'X-Epic-Org-Id',
	campaignId: 'X-Epic-Campaign-Id',
	journeyId: 'X-Epic-Journey-Id',
	customerId: 'X-Epic-Customer-Id',
	messageId: 'X-Epic-Message-Id',
} as const

export type MarketingEmailTagField = keyof ReturnType<
	typeof getMarketingEmailTags
>
export type MarketingEmailHeaderField = keyof ReturnType<
	typeof getMarketingEmailHeaders
>

/** Resend tag namespace from `brand.slug` (`menuza` → `epic_startup`). */
export function getMarketingEmailTagNamespace() {
	return brand.slug.replace(/-/g, '_')
}

export function getMarketingEmailTags() {
	const namespace = getMarketingEmailTagNamespace()
	return {
		scope: `${namespace}_scope`,
		messageId: `${namespace}_message_id`,
		campaignId: `${namespace}_campaign_id`,
	} as const
}

/** Header prefix from `brand.slug` (`menuza` → `Epic-Startup`). */
export function getMarketingEmailHeaderPrefix() {
	return brand.slug
		.split('-')
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('-')
}

export function getMarketingEmailHeaders() {
	const prefix = getMarketingEmailHeaderPrefix()
	return {
		orgId: `X-${prefix}-Org-Id`,
		campaignId: `X-${prefix}-Campaign-Id`,
		journeyId: `X-${prefix}-Journey-Id`,
		customerId: `X-${prefix}-Customer-Id`,
		messageId: `X-${prefix}-Message-Id`,
	} as const
}

function headerValueCaseInsensitive(
	headers: Record<string, string> | undefined,
	name: string,
): string | null {
	if (!headers) return null
	const direct = headers[name]
	if (direct) return direct
	const lower = name.toLowerCase()
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value
	}
	return null
}

export function getMarketingEmailTagValue(
	tags: Record<string, string> | undefined,
	field: MarketingEmailTagField,
): string | null {
	if (!tags) return null
	const current = getMarketingEmailTags()
	return (
		tags[current[field]] ?? tags[LEGACY_MARKETING_EMAIL_TAGS[field]] ?? null
	)
}

export function isPlatformMarketingEmailScope(
	tags: Record<string, string> | undefined,
): boolean {
	return (
		getMarketingEmailTagValue(tags, 'scope') === MARKETING_EMAIL_PLATFORM_SCOPE
	)
}

export function getMarketingEmailHeaderValue(
	headers: Record<string, string> | undefined,
	field: MarketingEmailHeaderField,
): string | null {
	const current = getMarketingEmailHeaders()
	return (
		headerValueCaseInsensitive(headers, current[field]) ??
		headerValueCaseInsensitive(headers, LEGACY_MARKETING_EMAIL_HEADERS[field])
	)
}

export function buildPlatformMarketingResendTags(
	messageId: string,
	campaignId: string,
) {
	const tags = getMarketingEmailTags()
	return {
		[tags.scope]: MARKETING_EMAIL_PLATFORM_SCOPE,
		[tags.messageId]: messageId,
		[tags.campaignId]: campaignId,
	}
}

export function buildTenantMarketingEmailHeaders(context: {
	orgId?: string
	campaignId?: string
	journeyId?: string
	customerId?: string
	messageId?: string
}) {
	const headers = getMarketingEmailHeaders()
	const headerFields: Record<string, string> = {}

	if (context.orgId) headerFields[headers.orgId] = context.orgId
	if (context.campaignId) headerFields[headers.campaignId] = context.campaignId
	if (context.journeyId) headerFields[headers.journeyId] = context.journeyId
	if (context.customerId) headerFields[headers.customerId] = context.customerId
	if (context.messageId) headerFields[headers.messageId] = context.messageId

	return headerFields
}

/** OCI Logging query filter for org-scoped engagement (current + legacy headers). */
export function buildOciMarketingOrgIdLogFilter(orgId: string) {
	const current = getMarketingEmailHeaders()
	const legacy = LEGACY_MARKETING_EMAIL_HEADERS
	const escaped = orgId.replace(/'/g, "''")
	return ` and (data.headers."${current.orgId}" = '${escaped}' or data.headers."${legacy.orgId}" = '${escaped}')`
}
