import { buildTenantMarketingEmailHeaders } from '@repo/config/marketing-email'
import {
	isOciEmailConfigured,
	sendOciEmail,
	shouldUseOciEmailMockTransport,
	type SendOciEmailInput,
	type SendOciEmailResult,
} from '@repo/email'

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

export async function sendTenantEmail(
	input: Omit<SendOciEmailInput, 'headerFields' | 'messageId'> & {
		context?: TenantEmailContext
		capture?: TenantEmailCaptureMeta
		from?: string
		/** Extra message headers (for example `List-Unsubscribe`). */
		extraHeaders?: Record<string, string>
	},
): Promise<SendOciEmailResult> {
	const headerFields = input.context
		? buildTenantMarketingEmailHeaders(input.context)
		: {}

	const { context, capture, from, extraHeaders, ...rest } = input
	const allHeaders = { ...headerFields, ...extraHeaders }
	const result = await sendOciEmail({
		...rest,
		messageId: context?.messageId ?? capture?.messageId,
		headerFields: Object.keys(allHeaders).length > 0 ? allHeaders : undefined,
	})

	// Only the plain "not configured" mock branch is captured, after its log line.
	if (devCapture && result.status === 'skipped') {
		try {
			await devCapture({
				to: input.to,
				from: from ?? 'noreply@dev.example.test',
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
