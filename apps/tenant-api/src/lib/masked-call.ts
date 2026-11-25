import { ENV } from 'varlock/env'
import { getNodeRegion } from './region.ts'
import { syncEnvFromProcess } from './secrets.ts'

/**
 * The masked call from a driver to a guest (#287). The driver's device never
 * receives the guest's number: the region reads both numbers, rings the driver
 * and, when they answer, dials the guest from the platform number. Neither
 * number is returned, stored in a log or put in an error.
 *
 * Twilio places the call from the US node only (Twilio is blocked for KSA
 * production, #78): everywhere else the call is unavailable, the driver view
 * hides the button and the driver uses the restaurant's number. Development and
 * tests use a bridge that connects nothing and calls no host.
 */
export interface MaskedCallBridge {
	readonly name: string
	available(): boolean
	connect(input: { driverPhone: string; guestPhone: string }): Promise<boolean>
}

let override: MaskedCallBridge | null | undefined

function escapeXml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
}

function twilioBridge(): MaskedCallBridge | null {
	syncEnvFromProcess()
	const accountSid = ENV.TWILIO_ACCOUNT_SID
	const authToken = ENV.TWILIO_AUTH_TOKEN
	const from = ENV.TWILIO_FROM_NUMBER
	if (!accountSid || !authToken || !from) return null
	return {
		name: 'twilio',
		available: () => safeRegion() === 'us',
		async connect({ driverPhone, guestPhone }) {
			const response = await fetch(
				`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
				{
					method: 'POST',
					headers: {
						Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: new URLSearchParams({
						To: driverPhone,
						From: from,
						Twiml: `<Response><Dial callerId="${escapeXml(from)}">${escapeXml(guestPhone)}</Dial></Response>`,
					}),
					redirect: 'error',
					signal: AbortSignal.timeout(8_000),
				},
			)
			return response.ok
		},
	}
}

function safeRegion(): 'us' | 'ksa' | null {
	try {
		return getNodeRegion()
	} catch {
		return null
	}
}

const devBridge: MaskedCallBridge = {
	name: 'dev',
	available: () => true,
	connect: async () => true,
}

/** The bridge for this node, or null when no call can be placed. */
export function getMaskedCallBridge(): MaskedCallBridge | null {
	if (override !== undefined) return override
	const twilio = twilioBridge()
	if (twilio) return twilio
	const nodeEnv =
		typeof process !== 'undefined' ? process.env.NODE_ENV : undefined
	return nodeEnv === 'development' || nodeEnv === 'test' ? devBridge : null
}

/** Whether a call between these two people can be offered. */
export function maskedCallOffered(input: {
	guestPhone: string | null
	driverPhone: string | null
}): boolean {
	const bridge = getMaskedCallBridge()
	return Boolean(
		bridge?.available() && input.guestPhone && input.driverPhone,
	)
}

/** Test hook: force a bridge (or `null`); pass `undefined` to reset. */
export function setMaskedCallBridgeForTesting(
	bridge: MaskedCallBridge | null | undefined,
) {
	override = bridge
}
