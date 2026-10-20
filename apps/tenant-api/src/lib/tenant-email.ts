import { buildTenantMarketingEmailHeaders } from '@repo/config/marketing-email'
import {
	sendOciEmail,
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

export async function sendTenantEmail(
	input: Omit<SendOciEmailInput, 'headerFields' | 'messageId'> & {
		context?: TenantEmailContext
		capture?: TenantEmailCaptureMeta
		from?: string
	},
): Promise<SendOciEmailResult> {
	const headerFields = input.context
		? buildTenantMarketingEmailHeaders(input.context)
		: {}

	const { context, capture, from, ...rest } = input
	const result = await sendOciEmail({
		...rest,
		messageId: context?.messageId ?? capture?.messageId,
		headerFields:
			Object.keys(headerFields).length > 0 ? headerFields : undefined,
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
