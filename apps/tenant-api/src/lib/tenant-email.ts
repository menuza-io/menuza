import { resolveSender } from '@repo/common/email-sender'
import { brand } from '@repo/config/brand'
import { buildTenantMarketingEmailHeaders } from '@repo/config/marketing-email'
import {
	getOciEmailConfig,
	isOciEmailConfigured,
	sendOciEmail,
	shouldUseOciEmailMockTransport,
	type SendOciEmailInput,
	type SendOciEmailResult,
} from '@repo/email'

import { getOrgEmailSender } from './org-email-sender.ts'

export type TenantEmailContext = {
	orgId: string
	campaignId?: string
	journeyId?: string
	customerId?: string
	messageId?: string
}

/** Ids only: the capture record never carries a name, phone or address. */
export type TenantEmailCaptureMeta = {
	orgId?: string
	messageKind?: string
	messageId?: string
}

export type TenantEmailCapture = (record: {
	to: string
	from: string
	subject: string
	html: string
	text: string
	meta: TenantEmailCaptureMeta
}) => Promise<unknown>

let devCapture: TenantEmailCapture | null = null

/** The Node entry registers the file sink; the Workers entry never does. */
export function setTenantEmailDevCapture(sink: TenantEmailCapture | null) {
	devCapture = sink
}

/**
 * Whether `sendTenantEmail` can do something on this node: OCI Email Delivery
 * is configured, the mock transport is on (tests, `MOCKS=true`) or the Node
 * entry registered the development file sink. Used by the person-driven sends
 * (an inventory order) that report "not sent from here" instead of failing
 * when the node has no email; automated mail keeps calling `sendTenantEmail`.
 */
export function canSendTenantEmail(): boolean {
	return (
		devCapture !== null ||
		shouldUseOciEmailMockTransport() ||
		isOciEmailConfigured()
	)
}

/**
 * What this message goes out as (#103): the organization's sender name and
 * verified reply-to, from the platform address until its own domain is
 * verified, then from `<local part>@<their domain>`. Works from the
 * organization the caller names (`orgId`, or the one in `context` or
 * `capture`); with none, or when the lookup fails, the platform sender stays.
 */
async function resolveOutgoingSender(orgId: string | undefined) {
	// The node's own sender settings; a node with none (or a test double that
	// does not model them) still sends, from whatever the provider defaults to.
	let config: ReturnType<typeof getOciEmailConfig> = null
	try {
		config = getOciEmailConfig()
	} catch {
		config = null
	}
	const platform = {
		email: config?.senderEmail ?? 'noreply@dev.example.test',
		name: config?.senderName ?? brand.name,
	}
	if (!orgId) return { platform, resolved: null }
	const meta = await getOrgEmailSender(orgId).catch(() => null)
	if (!meta) return { platform, resolved: null }
	return {
		platform,
		resolved: resolveSender({
			identity: meta.identity,
			organizationName: meta.organizationName,
			platform,
		}),
	}
}

export async function sendTenantEmail(
	input: Omit<
		SendOciEmailInput,
		'headerFields' | 'messageId' | 'sender' | 'replyTo'
	> & {
		context?: TenantEmailContext
		capture?: TenantEmailCaptureMeta
		from?: string
		/** The organization the message is sent for, when `context` and `capture` name none. */
		orgId?: string
		/** Extra message headers (for example `List-Unsubscribe`). */
		extraHeaders?: Record<string, string>
	},
): Promise<SendOciEmailResult> {
	const headerFields = input.context
		? buildTenantMarketingEmailHeaders(input.context)
		: {}

	const { context, capture, from, extraHeaders, orgId, ...rest } = input
	const allHeaders = { ...headerFields, ...extraHeaders }
	const { resolved, platform } = await resolveOutgoingSender(
		orgId ?? context?.orgId ?? capture?.orgId,
	)
	// Only an organization that has settings changes the sender; others keep
	// the platform's, exactly as before.
	const result = await sendOciEmail({
		...rest,
		messageId: context?.messageId ?? capture?.messageId,
		headerFields: Object.keys(allHeaders).length > 0 ? allHeaders : undefined,
		...(resolved
			? {
					sender: resolved.sender,
					...(resolved.replyTo ? { replyTo: resolved.replyTo } : {}),
				}
			: {}),
	})

	// Only the plain "not configured" mock branch is captured, after its log line.
	if (devCapture && result.status === 'skipped') {
		try {
			await devCapture({
				to: input.to,
				from: from ?? resolved?.sender.email ?? platform.email,
				subject: input.subject,
				html: input.html,
				text: input.text,
				meta: {
					orgId: capture?.orgId ?? context?.orgId,
					messageKind: capture?.messageKind,
					messageId: capture?.messageId ?? context?.messageId,
				},
			})
		} catch {
			// A capture failure must never fail a send.
		}
	}
	return result
}
