import { t } from '@lingui/macro'
import { parsePosDeviceSecret } from '@repo/common/pos-orders'
import { z } from 'zod'
import { noteServerDate } from './clock.ts'
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

/** Undefined when absent, null when present but not an http(s) origin. */
const originParam = (value: string | null): string | null | undefined => {
	if (value === null || value.trim() === '') return undefined
	try {
		const url = new URL(value.trim())
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
		return url.origin
	} catch {
		return null
	}
}

/**
 * Reads a pasted code, a full link, or a link's fragment. A link whose server
 * address is not an http(s) origin is refused outright, never half-read: falling
 * back to the address already set would pair somewhere the link did not say.
 */
export function parsePairingInput(text: string): PairingInput | null {
	const value = text.trim()
	if (CODE.test(value)) return { code: value }
	const hash = value.includes('#')
		? value.slice(value.indexOf('#') + 1)
		: value.replace(/^[?#]/, '')
	const params = new URLSearchParams(hash)
	const code = params.get('c')?.trim() ?? ''
	if (!CODE.test(code)) return null
	const tenantApiUrl = originParam(params.get('a'))
	const appUrl = originParam(params.get('u'))
	if (tenantApiUrl === null || appUrl === null) return null
	return {
		code,
		tenantApiUrl,
		appUrl,
		slug: params.get('s')?.trim().toLowerCase() || undefined,
	}
}

/** Hosts that only exist on a developer's machine, where plain http is fine. */
const DEV_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$|\.(test|localhost)$/

/** Which servers this build may be pointed at. */
export type OriginPolicy = {
	/** `VITE_POS_ALLOWED_ORIGINS`, split. Empty allows any (development builds only). */
	allowed: string[]
	/** A production build: an empty allow-list then refuses every server. */
	production: boolean
}

export const parseAllowedOrigins = (value: string | undefined): string[] =>
	(value ?? '')
		.split(',')
		.map((o) => originParam(o.trim()))
		.filter((o): o is string => typeof o === 'string')

export const buildOriginPolicy = (): OriginPolicy => ({
	allowed: parseAllowedOrigins(import.meta.env.VITE_POS_ALLOWED_ORIGINS),
	production: import.meta.env.PROD,
})

/**
 * Why this till may not talk to `value`, or null when it may. Orders carry
 * guest names and phone numbers and the device secret signs staff in, so a
 * server must be https (plain http only on a developer's own machine) and, in
 * a production build, one the deployment named in `VITE_POS_ALLOWED_ORIGINS`.
 */
export function serverOriginProblem(
	value: string,
	policy: OriginPolicy = buildOriginPolicy(),
): string | null {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return t`That server address is not a valid web address.`
	}
	const host = url.host
	if (
		url.protocol !== 'https:' &&
		!(url.protocol === 'http:' && DEV_HOST.test(url.hostname))
	)
		return t`The server ${host} does not use a secure (https) connection.`
	if (policy.allowed.length === 0) {
		return policy.production
			? t`This app was built without a list of trusted servers, so it cannot connect to ${host}. Ask whoever installed it to set VITE_POS_ALLOWED_ORIGINS.`
			: null
	}
	if (!policy.allowed.includes(url.origin))
		return t`${host} is not a server this app is set up to trust.`
	return null
}

/** Checks every server address that is set; the first problem, or null. */
export function serversProblem(
	addresses: Array<string | undefined | null>,
	policy: OriginPolicy = buildOriginPolicy(),
): string | null {
	for (const address of addresses) {
		if (!address) continue
		const problem = serverOriginProblem(address, policy)
		if (problem) return problem
	}
	return null
}

/** The host a link would point the till at (shown before anything changes), or null. */
export const pairingHosts = (
	parsed: PairingInput,
): { api: string | null; app: string | null } => ({
	api: parsed.tenantApiUrl ? new URL(parsed.tenantApiUrl).host : null,
	app: parsed.appUrl ? new URL(parsed.appUrl).host : null,
})

/** The server's answer to a successful pairing. Anything else is not trusted. */
const pairResponseSchema = z.object({
	deviceSecret: z
		.string()
		.refine((value) => parsePosDeviceSecret(value) !== null),
	device: z.object({
		terminalCode: z.string().trim().min(1).max(6),
		locationId: z.string().min(1).max(200).nullable(),
		label: z.string().max(200),
		scopeId: z.string().min(1).max(200).optional(),
		signInRequired: z.boolean().optional(),
		dayStartMinutes: z.number().int().min(0).max(1439).optional(),
		shiftsRequired: z.boolean().optional(),
	}),
})

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
		const sentAt = Date.now()
		const response = await fetch(
			`${tenantApiUrl.replace(/\/+$/, '')}/pos/pair`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code }),
				signal: AbortSignal.timeout(15_000),
			},
		)
		noteServerDate(response, sentAt)
		if (response.status === 201) {
			const parsed = pairResponseSchema.safeParse(
				await response.json().catch(() => null),
			)
			// A 201 we cannot read is not a pairing: a captive portal, a proxy, or
			// something that is not the orders server. Never store what it sent.
			if (!parsed.success)
				return {
					ok: false,
					error: t`The server’s answer was not a pairing. Check the link and try again.`,
				}
			const body = parsed.data
			return {
				ok: true,
				deviceToken: body.deviceSecret,
				terminalCode: body.device.terminalCode,
				locationId: body.device.locationId,
				deviceLabel: body.device.label,
				scopeId: body.device.scopeId ?? 'main',
				signInRequired: body.device.signInRequired ?? false,
				dayStartMinutes: body.device.dayStartMinutes ?? null,
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
