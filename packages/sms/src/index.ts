import twilio from 'twilio'
import { ENV } from './package-env.js'

let twilioClient: twilio.Twilio | null = null

function isExplicitLocalRuntime() {
	return (
		process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
	)
}

export function getTwilioClient() {
	if (!twilioClient) {
		const accountSid = ENV.TWILIO_ACCOUNT_SID
		const authToken = ENV.TWILIO_AUTH_TOKEN

		if (!accountSid || !authToken) {
			console.warn(
				'Twilio credentials not found. SMS will be logged to console.',
			)
		} else {
			twilioClient = twilio(accountSid, authToken)
		}
	}
	return twilioClient
}

export async function sendSms({
	to,
	message,
}: {
	to: string
	message: string
}) {
	const from = ENV.TWILIO_FROM_NUMBER
	const client = getTwilioClient()

	if (!client || !from) {
		// Only an explicit local NODE_ENV may print the message. An unset
		// value is production, so a missing credential cannot log the OTP.
		if (!isExplicitLocalRuntime()) {
			throw new Error(
				'Twilio credentials not found. SMS disabled in production.',
			)
		}
		console.info(`[SMS MOCK] To: ${to} | Message: ${message}`)
		return { success: true, mock: true }
	}

	const region = (ENV.DATA_REGION || 'us').toLowerCase()
	if (!isExplicitLocalRuntime() && region === 'ksa') {
		throw new Error(
			'Twilio must not be used for KSA customer PII. Configure an in-kingdom SMS provider (see docs/tenant-data-residency.md).',
		)
	}

	try {
		const response = await client.messages.create({
			body: message,
			from,
			to,
		})
		return { success: true, sid: response.sid, mock: false }
	} catch (error) {
		console.error('Failed to send SMS via Twilio', error)
		throw error
	}
}
