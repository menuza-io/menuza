import { brand } from '@repo/config/brand'
import { ENV } from '../package-env.js'
import { getOciEmailConfig } from './config.ts'

/** MSW-intercepted URL used when `MOCKS=true` (mirrors Resend's api.resend.com pattern). */
export const OCI_EMAIL_MOCK_SUBMIT_URL =
	'https://mock.epic-stack.test/oci-email/actions/submitEmail'

export function shouldUseOciEmailMockTransport() {
	return String(ENV.MOCKS) === 'true'
}

type MockTransportInput = {
	to: string
	toName?: string | null
	subject: string
	html: string
	text: string
	messageId?: string
	headerFields?: Record<string, string>
}

type MockTransportResult =
	| {
			status: 'success'
			data: { messageId: string; opcRequestId?: string }
	  }
	| {
			status: 'error'
			error: { message: string; statusCode?: number }
	  }

export async function sendOciEmailViaMockTransport(
	input: MockTransportInput,
): Promise<MockTransportResult> {
	const config = getOciEmailConfig()

	const response = await fetch(OCI_EMAIL_MOCK_SUBMIT_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			submitEmailDetails: {
				messageId: input.messageId,
				subject: input.subject,
				bodyHtml: input.html,
				bodyText: input.text,
				recipients: {
					to: [{ email: input.to, name: input.toName || input.to }],
				},
				sender: {
					senderAddress: {
						email: config?.senderEmail ?? brand.supportEmail,
						name: config?.senderName ?? brand.shortName,
					},
				},
				headerFields: input.headerFields,
			},
		}),
	})

	if (!response.ok) {
		const message = await response.text()
		return {
			status: 'error',
			error: {
				message: message || 'OCI email mock transport failed',
				statusCode: response.status,
			},
		}
	}

	const data = (await response.json()) as {
		emailSubmittedResponse?: { messageId?: string }
		opcRequestId?: string
	}

	const messageId =
		data.emailSubmittedResponse?.messageId ||
		input.messageId ||
		`mock-${Date.now()}`

	return {
		status: 'success',
		data: {
			messageId,
			opcRequestId: data.opcRequestId,
		},
	}
}
