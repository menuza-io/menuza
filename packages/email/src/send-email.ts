import { render } from '@react-email/components'
import { ENV } from './package-env.ts'
import { brand } from '@repo/config/brand'
import { type ReactElement } from 'react'
import { z } from 'zod'
import { logger } from '@repo/observability'
import {
	marketingTagsToOciHeaders,
	getMarketingMessageIdFromTags,
} from './marketing-tags-to-headers.ts'
import { getEmailProvider } from './provider.ts'
import { sendOciEmail } from './oci/send-oci-email.ts'

const resendErrorSchema = z.union([
	z.object({
		name: z.string(),
		message: z.string(),
		statusCode: z.number(),
	}),
	z.object({
		name: z.literal('UnknownError'),
		message: z.literal('Unknown Error'),
		statusCode: z.literal(500),
		cause: z.any(),
	}),
])
type ResendError = z.infer<typeof resendErrorSchema>

const resendSuccessSchema = z.object({
	id: z.string(),
})

export type SendEmailResult =
	| { status: 'success'; data: { id: string } }
	| { status: 'error'; error: ResendError }

export type SendEmailInput = {
	to: string
	subject: string
	/** Resend tags / OCI headers for webhook or log correlation (e.g. platform marketing). */
	tags?: Record<string, string>
} & (
	| { html: string; text: string; react?: never }
	| { react: ReactElement; html?: never; text?: never }
)

export async function sendEmail(
	input: SendEmailInput,
): Promise<SendEmailResult> {
	const { to, subject, tags } = input
	let html: string
	let text: string

	if ('react' in input && input.react) {
		const rendered = await renderReactEmail(input.react)
		html = rendered.html
		text = rendered.text
	} else {
		html = input.html
		text = input.text
	}

	if (getEmailProvider() === 'oci') {
		return sendEmailViaOci({
			to,
			subject,
			html,
			text,
			tags,
		})
	}

	return sendEmailViaResend({
		to,
		subject,
		html,
		text,
		tags,
	})
}

async function sendEmailViaOci({
	to,
	subject,
	html,
	text,
	tags,
}: {
	to: string
	subject: string
	html: string
	text: string
	tags?: Record<string, string>
}): Promise<SendEmailResult> {
	const headerFields = marketingTagsToOciHeaders(tags)
	const taggedMessageId = getMarketingMessageIdFromTags(tags)

	const result = await sendOciEmail({
		to,
		subject,
		html,
		text,
		messageId: taggedMessageId,
		headerFields,
	})

	if (result.status === 'success') {
		return {
			status: 'success',
			data: { id: result.data.messageId },
		}
	}

	if (result.status === 'skipped') {
		return {
			status: 'success',
			data: { id: result.data.messageId },
		}
	}

	return {
		status: 'error',
		error: {
			name: 'OciEmailError',
			message: result.error.message,
			statusCode: result.error.statusCode ?? 500,
		},
	}
}

async function sendEmailViaResend({
	to,
	subject,
	html,
	text,
	tags,
}: {
	to: string
	subject: string
	html: string
	text: string
	tags?: Record<string, string>
}): Promise<SendEmailResult> {
	const from = brand.supportEmail

	const email = {
		from,
		to,
		subject,
		html,
		text,
		...(tags
			? {
					tags: Object.entries(tags).map(([name, value]) => ({ name, value })),
				}
			: null),
	}

	if (ENV.NODE_ENV === 'test') {
		logger.debug({ to, subject }, 'Test mode: sendEmail called')
	} else if (!ENV.RESEND_API_KEY && process.env.MOCKS !== 'true') {
		logger.warn(
			{ email },
			'RESEND_API_KEY not set and not in mocks mode. Email not sent.',
		)
		return {
			status: 'success',
			data: { id: 'mocked' },
		}
	}

	const response = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		body: JSON.stringify(email),
		headers: {
			Authorization: `Bearer ${ENV.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
		},
	})
	const data = await response.json()
	const parsedData = resendSuccessSchema.safeParse(data)

	if (response.ok && parsedData.success) {
		return {
			status: 'success',
			data: parsedData.data,
		}
	}

	const parseResult = resendErrorSchema.safeParse(data)
	if (parseResult.success) {
		return {
			status: 'error',
			error: parseResult.data,
		}
	}

	return {
		status: 'error',
		error: {
			name: 'UnknownError',
			message: 'Unknown Error',
			statusCode: 500,
			cause: data,
		},
	}
}

async function renderReactEmail(react: ReactElement) {
	const [html, text] = await Promise.all([
		render(react),
		render(react, { plainText: true }),
	])
	return { html, text }
}
