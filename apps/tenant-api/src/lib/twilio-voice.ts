import { ENV } from 'varlock/env'
import { syncEnvFromProcess } from './secrets.ts'

function escapeXml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
}

export function verificationCallTwiml(brandName: string, code: string) {
	// Comma-separated digits make text-to-speech read "1, 2, 3" instead of
	// "one hundred twenty-three".
	const digits = code.split('').join(', ')
	const sentence = escapeXml(
		`Your ${brandName} verification code is ${digits}.`,
	)
	return `<Response><Say>${sentence}</Say><Pause length="1"/><Say>Again, ${sentence}</Say></Response>`
}

/**
 * Places an outbound Twilio call that reads the code aloud. Uses the REST API
 * directly so it also runs on the Workers runtime. Mirrors @repo/sms: logs
 * instead of calling when Twilio is not configured outside production.
 */
export async function placeVerificationCall({
	to,
	code,
	brandName,
}: {
	to: string
	code: string
	brandName: string
}) {
	syncEnvFromProcess()
	const accountSid = ENV.TWILIO_ACCOUNT_SID
	const authToken = ENV.TWILIO_AUTH_TOKEN
	const from = ENV.TWILIO_FROM_NUMBER
	if (!accountSid || !authToken || !from) {
		if (ENV.NODE_ENV === 'production') {
			throw new Error('Twilio credentials not found. Calls disabled.')
		}
		console.info(`[CALL MOCK] To: ${to} | Verification code: ${code}`)
		return { success: true, mock: true }
	}

	const response = await fetch(
		`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
		{
			method: 'POST',
			headers: {
				Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				To: to,
				From: from,
				Twiml: verificationCallTwiml(brandName, code),
			}),
			signal: AbortSignal.timeout(10_000),
		},
	)
	if (!response.ok) {
		throw new Error(`Twilio call failed with status ${response.status}`)
	}
	return { success: true, mock: false }
}
