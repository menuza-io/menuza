import { type MiddlewareHandler } from 'hono'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { hasReservationsGrant } from './reservations-auth.ts'
import { peekRsvAuth } from './reservations-guard.ts'

/**
 * Contact details at a Station till. A host at a shared tablet sees who is
 * booked and for how many, and can recognise a guest by the end of their
 * number; full phone numbers and email addresses need the guest-details grant
 * (till managers). Applied to every answer a `station` token gets, so a new
 * route or field cannot leak them by forgetting a flag.
 */

// By pattern, not a list: a field added later (`contactPhoneE164`) is covered
// the day a route starts returning it. Only text values are touched, so flags
// such as `hasPhone` pass.
const PHONE_KEY = /phone/i
const EMAIL_KEY = /email/i

/** `+12125550111` becomes `•••• 0111`. */
export function maskPhone(value: string): string {
	const digits = value.replace(/\D/g, '')
	return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '••••'
}

export function redactContacts(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactContacts)
	if (!value || typeof value !== 'object') return value
	const out: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (PHONE_KEY.test(key) && typeof entry === 'string')
			out[key] = maskPhone(entry)
		else if (EMAIL_KEY.test(key) && typeof entry === 'string') out[key] = null
		else out[key] = redactContacts(entry)
	}
	return out
}

export function stationContactRedaction(): MiddlewareHandler {
	return async (c, next) => {
		await next()
		const ctx = peekRsvAuth(c)
		if (!ctx || ctx.channel !== 'station') return
		if (
			hasReservationsGrant(ctx, RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST)
		)
			return
		const type = c.res.headers.get('Content-Type') ?? ''
		if (!type.includes('application/json')) return
		const body = await c.res
			.clone()
			.json()
			.catch(() => undefined)
		if (body === undefined) return
		const headers = new Headers(c.res.headers)
		headers.delete('Content-Length')
		c.res = new Response(JSON.stringify(redactContacts(body)), {
			status: c.res.status,
			headers,
		})
	}
}
