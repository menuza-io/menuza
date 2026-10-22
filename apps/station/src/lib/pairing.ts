import { t } from '@lingui/macro'
import { type PosSettings } from './config.ts'

/**
 * What a pairing link or pasted code carries. The link (`…/#a=<api>&u=<app>&s=<slug>&c=<code>`)
 * configures a fresh terminal in one scan; a bare `ppc1.` code only pairs it.
 * The fragment never reaches a server, and the app clears it after reading.
 */
export type PairingInput = {
	code: string
	tenantApiUrl?: string
	appUrl?: string
	slug?: string
}

const CODE = /^ppc1\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{43}$/

const safeOrigin = (value: string | null | undefined): string | undefined => {
	if (!value) return undefined
	try {
		const url = new URL(value)
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
		return url.origin
	} catch {
		return undefined
	}
}

export function parsePairingInput(text: string): PairingInput | null {
	const value = text.trim()
	if (CODE.test(value)) return { code: value }
	const hash = value.includes('#')
		? value.slice(value.indexOf('#') + 1)
		: value.replace(/^[?#]/, '')
	const params = new URLSearchParams(hash)
	const code = params.get('c')?.trim() ?? ''
	if (!CODE.test(code)) return null
	return {
		code,
		tenantApiUrl: safeOrigin(params.get('a')),
		appUrl: safeOrigin(params.get('u')),
		slug: params.get('s')?.trim().toLowerCase() || undefined,
	}
}

export type PairingResult =
	| {
			ok: true
			deviceToken: string
			terminalCode: string
			locationId: string | null
			deviceLabel: string
			scopeId: string
			signInRequired: boolean
			dayStartMinutes: number | null
			shiftsRequired: boolean
	  }
	| { ok: false; error: string }

export async function pairTerminal(
	tenantApiUrl: string,
	code: string,
): Promise<PairingResult> {
	if (!tenantApiUrl)
		return { ok: false, error: t`Enter the orders server address first.` }
	try {
		const response = await fetch(
			`${tenantApiUrl.replace(/\/+$/, '')}/pos/pair`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code }),
				signal: AbortSignal.timeout(15_000),
			},
		)
		if (response.status === 201) {
			const body = (await response.json()) as {
				deviceSecret: string
				device: {
					terminalCode: string
					locationId: string | null
					label: string
					scopeId?: string
					signInRequired?: boolean
					dayStartMinutes?: number
					shiftsRequired?: boolean
				}
			}
			return {
				ok: true,
				deviceToken: body.deviceSecret,
				terminalCode: body.device.terminalCode,
				locationId: body.device.locationId,
				deviceLabel: body.device.label,
				scopeId: body.device.scopeId ?? 'main',
				signInRequired: body.device.signInRequired ?? false,
				dayStartMinutes:
					typeof body.device.dayStartMinutes === 'number'
						? body.device.dayStartMinutes
						: null,
				shiftsRequired: body.device.shiftsRequired === true,
			}
		}
		if (response.status === 401) {
			return {
				ok: false,
				error: t`That code has expired or was already used. Ask a manager for a new one.`,
			}
		}
		if (response.status === 503)
			return {
				ok: false,
				error: t`Terminals are switched off for this restaurant right now.`,
			}
		return {
			ok: false,
			error: t`The server answered ${response.status}. Try again.`,
		}
	} catch {
		return {
			ok: false,
			error: t`Could not reach the server. Check the connection and try again.`,
		}
	}
}

export const withPairing = (
	settings: PosSettings,
	paired: Extract<PairingResult, { ok: true }>,
): PosSettings => ({
	...settings,
	deviceToken: paired.deviceToken,
	terminalCode: paired.terminalCode,
	locationId: paired.locationId ?? settings.locationId,
	locationLocked: paired.locationId !== null,
	scopeId: paired.scopeId,
	signInRequired: paired.signInRequired,
	dayStartMinutes: paired.dayStartMinutes ?? settings.dayStartMinutes,
	shiftsRequired: paired.shiftsRequired,
	deviceLabel: paired.deviceLabel,
})
