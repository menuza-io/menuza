import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import {
	isTurnstileConfigured,
	parseTurnstileHostnames,
	verifyTurnstileToken,
} from '@repo/common/turnstile'
import {
	CAREERS_APPLY_MAX_BODY_BYTES,
	careersApplySchema,
} from '@repo/staffing'
import { getTenantDb } from '@repo/tenant-db'
import { getLivePosting } from '../lib/job-posting-context.ts'
import {
	resolveOrganizationForBrowserAuth,
	resolveOriginBinding,
} from '../lib/origin.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import { json, validationBody } from '../lib/staff-http.ts'
import { submitApplication } from '../services/careers-apply-service.ts'
import { describeStaffError, hashClientIp } from '../services/staff-audit.ts'

/**
 * `POST /careers/apply`: the public application form. No account, no token.
 * It is called straight from the organization's own website (the browser posts
 * to this regional node, never through the US Sites server), so an applicant's
 * name and contact details never transit the control plane.
 *
 * The organization is never chosen by the client: it is resolved from the
 * browser's `Origin` (a tenant subdomain or custom domain). `slug` and `host`
 * in the body are honored only for a local dev origin that has no tenant
 * subdomain, and one that disagrees with a real Origin is refused. A request
 * with no Origin resolves nothing in production.
 *
 * Order of checks: body size, honeypot (answered like a success so a bot learns
 * nothing), organization from Origin, strict body validation, challenge token,
 * the live posting from the control plane, then the abuse limits and the write.
 * Every answer is `{ error: <code> }` or `{ received: true }`: a repeat
 * application looks exactly like a first one.
 */
export const careersRoutes = new Hono()

const TURNSTILE_ACTION = 'careers-apply'

const identitySchema = z.object({
	slug: z.string().max(63).optional(),
	host: z.string().max(253).optional(),
})

function refuse(error: string, status: 400 | 403 | 404 | 413 | 429 | 503) {
	return Response.json(
		{ error },
		{ status, headers: { 'Cache-Control': 'private, no-store' } },
	)
}

async function verifyChallenge(c: Context, token: unknown): Promise<boolean> {
	const secret = ENV.TURNSTILE_SECRET_KEY ?? ''
	// No secret configured (local development): the challenge is off.
	if (!isTurnstileConfigured(secret)) return true
	if (typeof token !== 'string' || !token.trim()) return false
	const ip = c.req.header('cf-connecting-ip')?.trim()
	const result = await verifyTurnstileToken({
		secret,
		token,
		remoteIp: ip || undefined,
		expectedAction: TURNSTILE_ACTION,
		expectedHostnames: parseTurnstileHostnames(ENV.TURNSTILE_HOSTNAMES),
	})
	return result.success
}

careersRoutes.post(
	'/apply',
	bodyLimit({
		maxSize: CAREERS_APPLY_MAX_BODY_BYTES,
		onError: () => refuse('payload_too_large', 413),
	}),
	async (c) => {
		let raw: unknown
		try {
			raw = await c.req.json()
		} catch {
			return refuse('invalid_request', 400)
		}
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return refuse('invalid_request', 400)
		}
		const body = raw as Record<string, unknown>

		// Honeypot: a real person never fills this. Same answer as a success.
		if (typeof body.website === 'string' && body.website.trim() !== '') {
			return json({ received: true }, 201)
		}

		const identity = identitySchema.safeParse({
			slug: body.slug,
			host: body.host,
		})
		if (!identity.success) return refuse('invalid_request', 400)
		const origin = c.req.header('Origin')
		// Only an organization's own site origin (a tenant subdomain or a custom
		// domain) or a local development origin may apply. The platform's app and
		// admin origins, which the shared resolver also accepts, name no
		// organization and are refused here.
		const binding = resolveOriginBinding(origin)
		const organization =
			origin &&
			(binding.kind === 'slug' ||
				binding.kind === 'custom' ||
				binding.kind === 'local-unbound')
				? await resolveOrganizationForBrowserAuth(origin, identity.data)
				: null
		if (
			!organization ||
			!organization.hasProvisionedDb ||
			!orgMatchesNodeRegion(organization.dataRegion)
		) {
			return refuse('not_found', 404)
		}

		const parsed = careersApplySchema.safeParse(body)
		if (!parsed.success) {
			return Response.json(validationBody(parsed.error), {
				status: 400,
				headers: { 'Cache-Control': 'private, no-store' },
			})
		}

		if (!(await verifyChallenge(c, parsed.data.turnstileToken))) {
			return refuse('verification_failed', 403)
		}

		const lookup = await getLivePosting(
			organization.id,
			parsed.data.postingSlug,
		)
		if (lookup.status === 'unavailable') return refuse('unavailable', 503)
		if (lookup.status === 'not_found') return refuse('posting_not_found', 404)

		try {
			const db = await getTenantDb(organization.id)
			const outcome = await submitApplication(db, {
				orgId: organization.id,
				posting: lookup.posting,
				body: parsed.data,
				ipHash: hashClientIp(c),
				now: Date.now(),
			})
			if (outcome.status === 'rate_limited') {
				return refuse('rate_limit_exceeded', 429)
			}
			if (outcome.status === 'invalid_scope') {
				return refuse('invalid_scope', 400)
			}
			if (outcome.status === 'invalid_answers') {
				return Response.json(
					{ error: 'invalid_answers', problems: outcome.problems },
					{ status: 400, headers: { 'Cache-Control': 'private, no-store' } },
				)
			}
			return json({ received: true }, 201)
		} catch (error) {
			console.error('Careers apply failed', describeStaffError(error))
			return refuse('unavailable', 503)
		}
	},
)
