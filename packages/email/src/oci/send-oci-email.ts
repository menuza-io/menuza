import emaildataplane from 'oci-emaildataplane'
import { ENV } from '../package-env.js'
import { createOciAuthProvider, getOciEmailConfig } from './config.ts'
import {
	sendOciEmailViaMockTransport,
	shouldUseOciEmailMockTransport,
} from './mock-transport.ts'

export type SendOciEmailInput = {
	to: string
	toName?: string | null
	subject: string
	html: string
	text: string
	/** RFC 5322 Message-ID for log correlation (optional). */
	messageId?: string
	/** Custom headers for campaign/journey correlation in OCI logs. */
	headerFields?: Record<string, string>
}

export type SendOciEmailResult =
	| {
			status: 'success'
			data: { messageId: string; opcRequestId?: string }
	  }
	| {
			status: 'error'
			error: { message: string; statusCode?: number }
	  }
	| {
			status: 'skipped'
			data: { mock: true; messageId: string }
	  }

export async function sendOciEmail(
	input: SendOciEmailInput,
): Promise<SendOciEmailResult> {
	if (shouldUseOciEmailMockTransport()) {
		return sendOciEmailViaMockTransport(input)
	}

	const config = getOciEmailConfig()

	if (!config) {
		if (ENV.NODE_ENV === 'production') {
			return {
				status: 'error',
				error: {
					message:
						'OCI Email Delivery is not configured. Set OCI_* and OCI_EMAIL_* environment variables.',
				},
			}
		}

		console.info(`[OCI EMAIL MOCK] To: ${input.to} | Subject: ${input.subject}`)
		return {
			status: 'skipped',
			data: {
				mock: true,
				messageId: input.messageId || `mock-${Date.now()}`,
			},
		}
	}

	try {
		const provider = createOciAuthProvider(config)
		const client = new emaildataplane.EmailDPClient({
			authenticationDetailsProvider: provider,
		})

		const response = await client.submitEmail({
			submitEmailDetails: {
				messageId: input.messageId,
				sender: {
					compartmentId: config.compartmentId,
					senderAddress: {
						email: config.senderEmail,
						name: config.senderName,
					},
				},
				recipients: {
					to: [
						{
							email: input.to,
							name: input.toName || input.to,
						},
					],
				},
				subject: input.subject,
				bodyHtml: input.html,
				bodyText: input.text,
				headerFields: input.headerFields,
			},
		})

		const submittedMessageId =
			response.emailSubmittedResponse?.messageId ||
			input.messageId ||
			`oci-${Date.now()}`

		return {
			status: 'success',
			data: {
				messageId: submittedMessageId,
				opcRequestId: response.opcRequestId,
			},
		}
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Failed to send email via OCI'
		console.error('OCI Email Delivery send failed:', error)
		return {
			status: 'error',
			error: { message },
		}
	}
}
