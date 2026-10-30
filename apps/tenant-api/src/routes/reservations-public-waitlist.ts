import { createHash } from 'node:crypto'
import {
	publicJoinWaitlistSchema,
	publicNotifyMeRequestSchema,
} from '@repo/reservations'
import { getTenantDb } from '@repo/tenant-db'
import { type Context, type Hono } from 'hono'
import { z } from 'zod'
import { HttpError, json } from '../lib/http.ts'
import { type PublishedOrganization } from '../lib/origin.ts'
import { guestLocaleFor, type LocaleOrg } from '../lib/reservations-i18n.ts'
import {
	clientIpHash,
	deriveWaitlistToken,
	enforceDurableLimit,
	notFoundResponse,
	purgeStaleRateCounters,
	randomFakeId,
	readCapabilityToken,
	readIdempotencyKey,
	readPublicBody,
	type ResolvedPublicOrg,
	verificationFailedResponse,
	verifyPublicChallenge,
} from '../lib/reservations-public-auth.ts'
import {
	cancelNotifyRequest,
	createNotifyRequest,
} from '../services/rsv-notify-service.ts'
import { requireBookableLocation } from '../services/rsv-public-service.ts'
import {
	buildPublicWaitlistStatus,
	createWaitlistEntry,
	findWaitlistEntryByToken,
	loadWaitlistEntry,
	setWaitlistEntryStatus,
	type WaitlistEntryRow,
} from '../services/rsv-waitlist-service.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** A status link stops answering this long after the party joined. */
const STATUS_LINK_LIFETIME_MS = 2 * DAY

type Limit = { name: string; max: number; windowMs: number }

/** The shared building blocks of the public router, handed in so this file never imports it back. */
export type PublicRouteKit = {
	gate: (
		c: Context,
		scope: 'booking' | 'manage',
		limit?: Limit,
	) => Promise<
		{ ok: true; value: ResolvedPublicOrg } | { ok: false; response: Response }
	>
	guarded: (
		handler: (c: Context) => Promise<Response>,
	) => (c: Context) => Promise<Response>
	methodNotAllowed: (c?: Context) => Response
	optionalCustomer: (
		c: Context,
		org: PublishedOrganization,
	) => Promise<{ customerId: string | null } | { error: Response }>
	readLocale: (c: Context, org: LocaleOrg) => string
	missingIdempotencyKey: () => HttpError
}

const joinSchema = publicJoinWaitlistSchema
const notifySchema = publicNotifyMeRequestSchema

const cancelSchema = z.object({ cancelToken: z.string().max(512).optional() })

const iso = (ms: number) => new Date(ms).toISOString()

function subjectHash(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

function fakeToken(prefix: string) {
	const part = () => randomFakeId('x').replace(/[^A-Za-z0-9]/g, '')
	return `${prefix}${part()}.${part()}`
}

async function readOptionalBody<S extends z.ZodTypeAny>(
	c: Context,
	schema: S,
): Promise<{ data: z.infer<S> } | { error: Response }> {
	const text = await c.req.text()
	if (!text.trim()) return { data: schema.parse({}) as z.infer<S> }
	return readPublicBody(c, schema)
}

/** Hono is strict about a trailing slash; the contract uses both forms. */
const bothForms = (path: string) => [path, `${path}/`]

export function registerPublicWaitlistRoutes(
	router: Hono,
	kit: PublicRouteKit,
) {
	const {
		gate,
		guarded,
		methodNotAllowed,
		optionalCustomer,
		readLocale,
		missingIdempotencyKey,
	} = kit

	/** Joining needs the waitlist module, online booking, and the location's own switches. */
	async function requireWaitlistLocation(
		g: ResolvedPublicOrg,
		locationId: string,
	) {
		if (!g.context.features.waitlist || !g.context.features.online) {
			throw new HttpError(404, 'not_found')
		}
		const db = await getTenantDb(g.org.id)
		const location = await requireBookableLocation(db, g.context, locationId)
		if (
			!location.settings.waitlistEnabled ||
			!location.settings.waitlistOnline
		) {
			throw new HttpError(404, 'not_found')
		}
		return { db, location }
	}

	router.on(
		'POST',
		bothForms('/waitlist/join'),
		guarded(async (c) => {
			const g = await gate(c, 'booking', {
				name: 'waitlist-join',
				max: 5,
				windowMs: 10 * MINUTE,
			})
			if (!g.ok) return g.response
			const { org } = g.value
			const body = await readPublicBody(c, joinSchema)
			if ('error' in body) return body.error
			const input = body.data

			if (input.website) {
				const now = Date.now()
				return json(
					{
						entry: {
							id: randomFakeId('wle'),
							status: 'waiting',
							position: 1,
							partySize: input.partySize,
							quotedMin: 15,
							quotedReadyAt: iso(now + 15 * MINUTE),
							locationId: input.locationId,
							locationName: null,
						},
						statusToken: fakeToken('rsv_w_'),
						now: iso(now),
					},
					201,
				)
			}

			const key = readIdempotencyKey(c)
			if (!key) throw missingIdempotencyKey()
			if (!input.phone?.trim() && !input.email?.trim()) {
				throw new HttpError(400, 'invalid', undefined, {
					issues: [{ path: 'phone', code: 'required' }],
				})
			}
			const customer = await optionalCustomer(c, org)
			if ('error' in customer) return customer.error
			const verified = await verifyPublicChallenge(c, input.turnstileToken, {
				hasCustomer: customer.customerId !== null,
			})
			if (!verified) return verificationFailedResponse()

			const { db, location } = await requireWaitlistLocation(
				g.value,
				input.locationId,
			)
			if (input.partySize > location.settings.partyMax) {
				throw new HttpError(400, 'party_size_invalid')
			}
			const ipHash = clientIpHash(c)
			const limited = await enforceDurableLimit(db, {
				bucket: 'waitlist_join_ip',
				subjectHash: ipHash,
				max: 5,
				windowMs: 10 * MINUTE,
			})
			if (limited) return limited
			await purgeStaleRateCounters(db).catch(() => undefined)

			const { entryId } = await createWaitlistEntry({
				orgId: org.id,
				locationId: input.locationId,
				idempotencyKey: key,
				channel: 'remote',
				remote: true,
				duplicateCode: 'already_on_waitlist',
				ipHash,
				input: {
					displayName: (input.name ?? input.displayName)!,
					partySize: input.partySize,
					phone: input.phone,
					email: input.email,
					smsOptIn: input.smsOptIn,
					areaPrefId: input.areaId ?? null,
					notes: input.notes,
					locale: guestLocaleFor(
						input.locale ?? readLocale(c, g.value.context.organization),
						g.value.context.organization,
					),
				},
			})
			const entry = await loadWaitlistEntry(org.id, entryId)
			const status = await buildPublicWaitlistStatus(
				db,
				g.value.context,
				entry,
				Date.now(),
			)
			return json(
				{
					entry: {
						id: entry.id,
						locationId: entry.locationId,
						locationName: status.locationName,
						status: status.status,
						position: status.position,
						partySize: status.partySize,
						quotedMin: status.quotedMin,
						quotedReadyAt: status.quotedReadyAt,
					},
					statusToken: deriveWaitlistToken(
						org.id,
						entry.id,
						entry.statusTokenVersion,
					),
					now: status.now,
				},
				201,
			)
		}),
	)

	/** A status token resolves to its entry, or every failure is the same 404. */
	async function resolveEntry(
		c: Context,
		limit: Limit,
	): Promise<
		| { ok: true; g: ResolvedPublicOrg; entry: WaitlistEntryRow; now: number }
		| { ok: false; response: Response }
	> {
		const g = await gate(c, 'manage', limit)
		if (!g.ok) return g
		if (!g.value.context.features.waitlist) {
			return { ok: false, response: notFoundResponse() }
		}
		const entry = await findWaitlistEntryByToken(
			g.value.org.id,
			readCapabilityToken(c),
		)
		const now = Date.now()
		if (!entry || now > entry.joinedAt + STATUS_LINK_LIFETIME_MS) {
			return { ok: false, response: notFoundResponse() }
		}
		return { ok: true, g: g.value, entry, now }
	}

	async function statusResponse(
		g: ResolvedPublicOrg,
		entryId: string,
	): Promise<Response> {
		const db = await getTenantDb(g.org.id)
		const fresh = await loadWaitlistEntry(g.org.id, entryId)
		return json(
			await buildPublicWaitlistStatus(db, g.context, fresh, Date.now()),
		)
	}

	router.on(
		'GET',
		bothForms('/waitlist/status'),
		guarded(async (c) => {
			const resolved = await resolveEntry(c, {
				name: 'waitlist-status',
				max: 120,
				windowMs: MINUTE,
			})
			if (!resolved.ok) return resolved.response
			return statusResponse(resolved.g, resolved.entry.id)
		}),
	)

	async function resolveEntryMutation(c: Context) {
		const resolved = await resolveEntry(c, {
			name: 'waitlist-write',
			max: 30,
			windowMs: MINUTE,
		})
		if (!resolved.ok) return resolved
		const db = await getTenantDb(resolved.g.org.id)
		const limited = await enforceDurableLimit(db, {
			bucket: 'waitlist_mutation',
			subjectHash: subjectHash(resolved.entry.id),
			max: 30,
			windowMs: HOUR,
		})
		if (limited) return { ok: false as const, response: limited }
		return resolved
	}

	router.on(
		'POST',
		bothForms('/waitlist/status/leave'),
		guarded(async (c) => {
			const resolved = await resolveEntryMutation(c)
			if (!resolved.ok) return resolved.response
			const body = await readOptionalBody(c, z.object({}).loose())
			if ('error' in body) return body.error
			await setWaitlistEntryStatus({
				orgId: resolved.g.org.id,
				entry: resolved.entry,
				status: 'left',
			})
			return statusResponse(resolved.g, resolved.entry.id)
		}),
	)

	router.on(
		'POST',
		bothForms('/waitlist/status/on-my-way'),
		guarded(async (c) => {
			const resolved = await resolveEntryMutation(c)
			if (!resolved.ok) return resolved.response
			const body = await readOptionalBody(c, z.object({}).loose())
			if ('error' in body) return body.error
			await setWaitlistEntryStatus({
				orgId: resolved.g.org.id,
				entry: resolved.entry,
				status: 'on_the_way',
			})
			return statusResponse(resolved.g, resolved.entry.id)
		}),
	)

	router.on(
		'POST',
		bothForms('/notify-me'),
		guarded(async (c) => {
			const g = await gate(c, 'booking', {
				name: 'notify-me',
				max: 5,
				windowMs: 10 * MINUTE,
			})
			if (!g.ok) return g.response
			const { org } = g.value
			const body = await readPublicBody(c, notifySchema)
			if ('error' in body) return body.error
			const input = body.data

			if (input.website) {
				const now = Date.now()
				return json(
					{
						request: {
							id: randomFakeId('nfy'),
							status: 'active',
							locationId: input.locationId,
							date: input.date,
							partySize: input.partySize,
							fromLocalMin: input.fromLocalMin,
							toLocalMin: input.toLocalMin,
							expiresAt: iso(now + DAY),
						},
						cancelToken: fakeToken('rsv_n_'),
						now: iso(now),
					},
					201,
				)
			}

			const key = readIdempotencyKey(c)
			if (!key) throw missingIdempotencyKey()
			if (!input.phone?.trim() && !input.email?.trim()) {
				throw new HttpError(400, 'invalid', undefined, {
					issues: [{ path: 'phone', code: 'required' }],
				})
			}
			const customer = await optionalCustomer(c, org)
			if ('error' in customer) return customer.error
			const verified = await verifyPublicChallenge(c, input.turnstileToken, {
				hasCustomer: customer.customerId !== null,
			})
			if (!verified) return verificationFailedResponse()

			if (!g.value.context.features.waitlist) {
				throw new HttpError(404, 'not_found')
			}
			const db = await getTenantDb(org.id)
			const location = await requireBookableLocation(
				db,
				g.value.context,
				input.locationId,
			)
			if (!location.settings.notifyMeEnabled) {
				throw new HttpError(404, 'not_found')
			}
			if (
				input.partySize < location.settings.onlinePartyMin ||
				input.partySize > location.settings.onlinePartyMax
			) {
				throw new HttpError(400, 'party_size_invalid')
			}
			const ipHash = clientIpHash(c)
			const limited = await enforceDurableLimit(db, {
				bucket: 'notify_me_ip',
				subjectHash: ipHash,
				max: 5,
				windowMs: 10 * MINUTE,
			})
			if (limited) return limited
			await purgeStaleRateCounters(db).catch(() => undefined)

			const created = await createNotifyRequest({
				orgId: org.id,
				idempotencyKey: key,
				ipHash,
				input: {
					locationId: input.locationId,
					businessDate: input.date,
					partySize: input.partySize,
					fromLocalMin: input.fromLocalMin,
					toLocalMin: input.toLocalMin,
					areaPrefId: input.areaId ?? null,
					phone: input.phone,
					email: input.email,
					locale: guestLocaleFor(
						input.locale ?? readLocale(c, g.value.context.organization),
						g.value.context.organization,
					),
				},
			})
			return json(
				{
					request: {
						id: created.requestId,
						status: 'active',
						locationId: input.locationId,
						date: input.date,
						partySize: input.partySize,
						fromLocalMin: input.fromLocalMin,
						toLocalMin: input.toLocalMin,
					},
					cancelToken: created.cancelToken,
					now: iso(Date.now()),
				},
				201,
			)
		}),
	)

	router.on(
		'POST',
		bothForms('/notify-me/cancel'),
		guarded(async (c) => {
			const g = await gate(c, 'manage', {
				name: 'notify-cancel',
				max: 30,
				windowMs: MINUTE,
			})
			if (!g.ok) return g.response
			const body = await readOptionalBody(c, cancelSchema)
			if ('error' in body) return body.error
			const token = readCapabilityToken(c) ?? body.data.cancelToken ?? null
			if (!token) return notFoundResponse()
			const db = await getTenantDb(g.value.org.id)
			const limited = await enforceDurableLimit(db, {
				bucket: 'notify_cancel_ip',
				subjectHash: clientIpHash(c),
				max: 30,
				windowMs: HOUR,
			})
			if (limited) return limited
			const cancelled = await cancelNotifyRequest({
				orgId: g.value.org.id,
				token,
			})
			if (!cancelled) return notFoundResponse()
			return json({ cancelled: true, now: iso(Date.now()) })
		}),
	)

	for (const path of [
		'/waitlist/join',
		'/waitlist/status/leave',
		'/waitlist/status/on-my-way',
		'/notify-me',
		'/notify-me/cancel',
	]) {
		for (const form of bothForms(path)) {
			router.all(form, async (c) => methodNotAllowed(c))
		}
	}
}
