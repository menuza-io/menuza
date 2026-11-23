import { recordSignInCodeDelivery } from '@repo/auth'
import {
	type SignInChannel,
	type SignInCodePurpose,
} from '@repo/common/sign-in-delivery'
import {
	sendEmail,
	type SendEmailInput,
	type SendEmailResult,
} from '@repo/email'

/**
 * The provider `sendEmail()` uses: the same rule as `getEmailProvider()` in
 * `@repo/email` (`EMAIL_PROVIDER=oci`, else Resend), read from the environment
 * here so this log does not depend on how that package is loaded.
 */
function emailProviderName(): 'resend' | 'oci' {
	return process.env.EMAIL_PROVIDER?.trim().toLowerCase() === 'oci'
		? 'oci'
		: 'resend'
}

/**
 * Sends the email that carries a one-time code (sign-up, password reset, a new
 * email address) and logs THAT it was sent (#246): the destination, the
 * provider and its message id, so a later Resend webhook can say delivered or
 * bounced. The code is in the email's body only. This function never reads the
 * body and the log has no column for a code.
 */
export async function sendCodeEmail(
	input: SendEmailInput & {
		purpose: SignInCodePurpose
		userId?: string | null
		organizationId?: string | null
	},
): Promise<SendEmailResult> {
	const { purpose, userId, organizationId, ...email } = input
	const result = await sendEmail(email as SendEmailInput)
	await recordSignInCodeDelivery({
		userId,
		organizationId,
		purpose,
		channel: 'email',
		destination: input.to,
		provider: emailProviderName(),
		providerMessageId:
			result.status === 'success' ? (result.data?.id ?? null) : null,
		status: result.status === 'success' ? 'sent' : 'failed',
		failureReason:
			result.status === 'success'
				? null
				: (result.error?.name ?? 'send_failed'),
	})
	return result
}

/** The channel and provider words for a text code, kept next to the email's. */
export const TEXT_CHANNEL: SignInChannel = 'sms'
