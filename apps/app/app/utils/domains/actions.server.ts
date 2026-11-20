import { type PrimaryForm } from '@repo/common/domains'
import { db, eq, ManagedDomain } from '@repo/database'
import { z } from 'zod'
import {
	checkRateLimit,
	type RateLimitConfig,
} from '#app/utils/rate-limit.server.ts'
import {
	approveAutoConnect,
	AutoConnectError,
	InstructionsError,
	planAutoConnect,
	sendDomainInstructions,
} from './auto-connect.server.ts'
import {
	addForward,
	disableForwarding,
	enableForwarding,
	ForwardingError,
	refreshForwarding,
	removeForward,
	resendConfirmation,
} from './forwarding.server.ts'
import { inspectDomain } from './inspect.server.ts'
import {
	confirmRegistrantEmail,
	lockDomain,
	RegistrarFlowError,
	resendRegistrantVerification,
	searchDomains,
	setAutoRenew,
	startPurchase,
	startTransferIn,
	transferOut,
} from './registrar.server.ts'
import {
	addSiteDomains,
	checkAndNotify,
	DomainError,
	disconnectAllDomains,
	ensureSiteDomains,
	removeSiteDomain,
	retryExpiredDomain,
	setPrimaryDomain,
} from './site-domains.server.ts'
import {
	addZoneRecord,
	checkManagedDomain,
	connectByNameservers,
	deleteZoneRecord,
	exportManagedZone,
	leaveManagedZone,
	scanDomain,
	updateZoneRecord,
	ZoneError,
} from './zone.server.ts'

/**
 * Every action of the Website, Domain screen (#139, #313, #283, #183, #276).
 * The route has already required `update:settings:any`; this parses the form
 * with one discriminated union on `intent`, runs the matching module and
 * answers `{ ok, intent, ... }` JSON the screen turns into words. Errors are
 * codes, never provider messages.
 */

export const LOOKUP_RATE_LIMIT: RateLimitConfig = {
	scope: 'domain-lookup',
	maxRequests: 40,
	windowMs: 60 * 60 * 1000,
}
export const INSTRUCTIONS_RATE_LIMIT: RateLimitConfig = {
	scope: 'domain-instructions',
	maxRequests: 5,
	windowMs: 60 * 60 * 1000,
}

const text = (max = 253) => z.string().trim().max(max)
const hostname = z.string().trim().min(1).max(300)
const primaryForm = z.enum(['www', 'apex']).default('www')
const id = z.string().trim().min(1).max(64)

const contactFields = {
	contact_firstName: text(60),
	contact_lastName: text(60),
	contact_organization: text(120),
	contact_email: text(254),
	contact_phone: text(30),
	contact_address1: text(120),
	contact_address2: text(120).optional(),
	contact_city: text(80),
	contact_state: text(80),
	contact_postalCode: text(20),
	contact_country: text(2),
}

const recordFields = {
	type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS']),
	name: text(253),
	content: text(2048),
	ttl: z.coerce.number().int().min(1).max(86400).optional(),
	priority: z
		.string()
		.trim()
		.optional()
		.transform((value) =>
			value === undefined || value === '' ? null : Number(value),
		),
}

const intents = z.discriminatedUnion('intent', [
	z.object({ intent: z.literal('inspect-domain'), hostname }),
	z.object({
		intent: z.literal('add-domain'),
		hostname,
		primaryForm,
		mode: z.enum(['primary', 'redirect']).default('primary'),
	}),
	z.object({ intent: z.literal('set-primary'), hostname }),
	z.object({ intent: z.literal('remove-domain'), hostname }),
	z.object({ intent: z.literal('disconnect-all') }),
	z.object({
		intent: z.literal('check-domain'),
		hostname: hostname.optional(),
	}),
	z.object({ intent: z.literal('check-certificate'), hostname }),
	z.object({ intent: z.literal('retry-domain'), hostname }),
	z.object({ intent: z.literal('plan-auto-connect'), hostname, primaryForm }),
	z.object({
		intent: z.literal('approve-auto-connect'),
		hostname,
		primaryForm,
	}),
	z.object({
		intent: z.literal('send-instructions'),
		hostname,
		primaryForm,
		to: text(254),
	}),
	z.object({
		intent: z.literal('scan-domain'),
		hostname,
		zoneFile: z.string().max(400_000).optional(),
	}),
	z.object({
		intent: z.literal('connect-nameservers'),
		hostname,
		primaryForm,
		zoneFile: z.string().max(400_000).optional(),
		emailConfirmation: text(300).optional(),
	}),
	z.object({ intent: z.literal('check-nameservers'), managedDomainId: id }),
	z.object({ intent: z.literal('leave-zone'), managedDomainId: id }),
	z.object({ intent: z.literal('export-zone'), managedDomainId: id }),
	z.object({
		intent: z.literal('add-record'),
		managedDomainId: id,
		...recordFields,
	}),
	z.object({
		intent: z.literal('update-record'),
		managedDomainId: id,
		recordId: id,
		...recordFields,
	}),
	z.object({
		intent: z.literal('delete-record'),
		managedDomainId: id,
		recordId: id,
	}),
	z.object({
		intent: z.literal('search-domains'),
		query: text(120).min(1),
		city: text(80).optional(),
	}),
	z.object({
		intent: z.literal('buy-domain'),
		fqdn: text(253),
		acceptedPriceCents: z.coerce.number().int().min(0).max(10_000_000),
		...contactFields,
	}),
	z.object({
		intent: z.literal('transfer-in'),
		fqdn: text(253),
		authCode: text(128).min(1),
		acceptedPriceCents: z.coerce.number().int().min(0).max(10_000_000),
		...contactFields,
	}),
	z.object({
		intent: z.literal('set-auto-renew'),
		managedDomainId: id,
		autoRenew: z.enum(['true', 'false']),
	}),
	z.object({ intent: z.literal('transfer-out'), managedDomainId: id }),
	z.object({ intent: z.literal('lock-domain'), managedDomainId: id }),
	z.object({
		intent: z.literal('resend-registrant-email'),
		managedDomainId: id,
	}),
	z.object({
		intent: z.literal('confirm-registrant-email'),
		managedDomainId: id,
	}),
	z.object({
		intent: z.literal('enable-forwarding'),
		managedDomainId: id,
		mxConfirmation: text(300).optional(),
	}),
	z.object({
		intent: z.literal('add-forward'),
		managedDomainId: id,
		localPart: text(64).min(1),
		destination: text(254).min(1),
		mxConfirmation: text(300).optional(),
	}),
	z.object({
		intent: z.literal('remove-forward'),
		managedDomainId: id,
		forwardId: id,
	}),
	z.object({
		intent: z.literal('resend-forward-confirmation'),
		managedDomainId: id,
		forwardId: id,
	}),
	z.object({ intent: z.literal('check-forwarding'), managedDomainId: id }),
	z.object({ intent: z.literal('disable-forwarding'), managedDomainId: id }),
])

export type DomainIntent = z.infer<typeof intents>['intent']
export const DOMAIN_INTENTS = intents.options.map(
	(option) => option.shape.intent.value,
)

export type ActionOrganization = {
	id: string
	slug: string
	name: string
	dataRegion: string
}

export type ActionContext = {
	organization: ActionOrganization
	userId: string
	userName: string
	request: Request
	/** The page URL, for return links. */
	origin: string
}

function fail(
	intent: string,
	error: string,
	status = 400,
	extra: Record<string, unknown> = {},
) {
	return Response.json({ ok: false, intent, error, ...extra }, { status })
}

function ok(intent: string, data: Record<string, unknown> = {}) {
	return Response.json({ ok: true, intent, ...data })
}

function contactOf(input: object) {
	const data = input as Record<string, string | undefined>
	return {
		firstName: data.contact_firstName,
		lastName: data.contact_lastName,
		organization: data.contact_organization,
		email: data.contact_email,
		phone: data.contact_phone,
		address1: data.contact_address1,
		address2: data.contact_address2 || undefined,
		city: data.contact_city,
		state: data.contact_state,
		postalCode: data.contact_postalCode,
		country: data.contact_country,
	}
}

async function limited(
	ctx: ActionContext,
	config: RateLimitConfig,
	intent: string,
) {
	const result = await checkRateLimit(
		{ type: 'org', value: ctx.organization.id },
		config,
	)
	if (result.allowed) return null
	return fail(intent, 'rate_limited', 429, {
		retryAfter: Math.max(
			1,
			Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
		),
	})
}

/** Turns a module's thrown error into the answer the screen expects. */
function answerError(intent: string, error: unknown): Response {
	if (error instanceof DomainError) {
		return fail(
			intent,
			error.code,
			error.code === 'hostname_taken' ? 409 : 422,
			{
				host: error.host,
			},
		)
	}
	if (error instanceof ZoneError) {
		return fail(
			intent,
			error.code,
			error.code === 'managed_readonly' ? 403 : 422,
			{
				issues: error.issues,
			},
		)
	}
	if (error instanceof ForwardingError) {
		return fail(
			intent,
			error.code,
			error.code === 'mx_confirmation_required' ? 409 : 422,
			{
				detail: error.detail,
			},
		)
	}
	if (error instanceof RegistrarFlowError) {
		const status =
			error.code === 'feature_off' || error.code === 'not_found'
				? 404
				: error.code === 'price_changed'
					? 409
					: 422
		return fail(intent, error.code, status, { detail: error.detail })
	}
	if (error instanceof AutoConnectError || error instanceof InstructionsError) {
		return fail(intent, error.code, 422)
	}
	console.error(
		`Domain action ${intent} failed:`,
		error instanceof Error ? error.message : error,
	)
	return fail(intent, 'unexpected', 500)
}

export async function handleDomainAction(
	formData: FormData,
	ctx: ActionContext,
): Promise<Response> {
	const parsed = intents.safeParse(Object.fromEntries(formData))
	const rawIntent = String(formData.get('intent') ?? '')
	if (!parsed.success)
		return fail(rawIntent || 'unknown', 'invalid_request', 400)
	const data = parsed.data
	const actor = { userId: ctx.userId, request: ctx.request }
	const organization = { id: ctx.organization.id, slug: ctx.organization.slug }
	const intent = data.intent

	try {
		switch (data.intent) {
			// ----- #139 / #313: connecting and checking ---------------------------------
			case 'inspect-domain': {
				const refused = await limited(ctx, LOOKUP_RATE_LIMIT, intent)
				if (refused) return refused
				const inspection = await inspectDomain({
					organizationId: ctx.organization.id,
					hostname: data.hostname,
				})
				return inspection
					? ok(intent, { inspection })
					: fail(intent, 'hostname_invalid', 422)
			}
			case 'add-domain': {
				const rows = await addSiteDomains({
					organization,
					hostname: data.hostname,
					primaryForm: data.primaryForm as PrimaryForm,
					mode: data.mode,
					actor,
				})
				return ok(intent, { hosts: rows.map((row) => row.hostname) })
			}
			case 'set-primary':
				await setPrimaryDomain({ organization, hostname: data.hostname, actor })
				return ok(intent)
			case 'remove-domain':
				await removeSiteDomain({ organization, hostname: data.hostname, actor })
				return ok(intent)
			case 'disconnect-all':
				await disconnectAllDomains({ organization, actor })
				return ok(intent)
			case 'check-domain':
			case 'check-certificate': {
				const rows = await ensureSiteDomains(ctx.organization.id)
				const wanted = data.hostname
					? rows.filter((row) => row.hostname === data.hostname!.toLowerCase())
					: rows.filter((row) => row.status !== 'expired')
				if (data.intent === 'check-certificate' && wanted.length === 0) {
					return fail(intent, 'not_found', 404)
				}
				const results = []
				for (const row of wanted) {
					const result = await checkAndNotify(row, {
						retryCertificate: data.intent === 'check-certificate',
					})
					results.push({ hostname: row.hostname, live: result.view.live })
				}
				return ok(intent, { results })
			}
			case 'retry-domain':
				await retryExpiredDomain({
					organization,
					hostname: data.hostname,
					actor,
				})
				return ok(intent)
			case 'plan-auto-connect': {
				const refused = await limited(ctx, LOOKUP_RATE_LIMIT, intent)
				if (refused) return refused
				const planned = await planAutoConnect({
					hostname: data.hostname,
					primaryForm: data.primaryForm as PrimaryForm,
				})
				return planned
					? ok(intent, { plan: planned.plan })
					: fail(intent, 'not_supported', 422)
			}
			case 'approve-auto-connect': {
				const result = await approveAutoConnect({
					organization,
					hostname: data.hostname,
					primaryForm: data.primaryForm as PrimaryForm,
					actor,
					redirectUri: `${ctx.origin}/${ctx.organization.slug}/website/domain?connected=1`,
				})
				return ok(
					intent,
					result.kind === 'redirect'
						? { redirect: result.url }
						: { applied: true },
				)
			}
			case 'send-instructions': {
				const refused = await limited(ctx, INSTRUCTIONS_RATE_LIMIT, intent)
				if (refused) return refused
				const result = await sendDomainInstructions({
					organizationName: ctx.organization.name,
					requestedBy: ctx.userName,
					hostname: data.hostname,
					primaryForm: data.primaryForm as PrimaryForm,
					to: data.to,
				})
				return result.sent ? ok(intent) : fail(intent, 'email_failed', 502)
			}

			// ----- #283: nameservers and records --------------------------------------
			case 'scan-domain': {
				const refused = await limited(ctx, LOOKUP_RATE_LIMIT, intent)
				if (refused) return refused
				const inspection = await inspectDomain({
					organizationId: ctx.organization.id,
					hostname: data.hostname,
				})
				if (!inspection) return fail(intent, 'hostname_invalid', 422)
				if (inspection.role === 'subdomain')
					return fail(intent, 'subdomain_not_allowed', 422, {
						suggestion: inspection.apex,
					})
				const scan = await scanDomain({
					domain: inspection.apex,
					zoneFile: data.zoneFile,
				})
				return ok(intent, {
					scan: { ...scan, records: scan.records.slice(0, 200) },
				})
			}
			case 'connect-nameservers': {
				const refused = await limited(ctx, LOOKUP_RATE_LIMIT, intent)
				if (refused) return refused
				const inspection = await inspectDomain({
					organizationId: ctx.organization.id,
					hostname: data.hostname,
				})
				if (!inspection) return fail(intent, 'hostname_invalid', 422)
				// Scanned again here: the safety verdict is the server's, never the browser's.
				const scan = await scanDomain({
					domain: inspection.apex,
					zoneFile: data.zoneFile,
				})
				const result = await connectByNameservers({
					organization,
					hostname: data.hostname,
					primaryForm: data.primaryForm as PrimaryForm,
					scan,
					emailConfirmation: data.emailConfirmation,
					actor,
				})
				return ok(intent, {
					nameservers: result.nameservers,
					domain: result.domain.fqdn,
				})
			}
			case 'check-nameservers': {
				const [row] = await db
					.select()
					.from(ManagedDomain)
					.where(eq(ManagedDomain.id, data.managedDomainId))
				if (!row || row.organizationId !== ctx.organization.id)
					return fail(intent, 'not_found', 404)
				const result = await checkManagedDomain(row)
				return ok(intent, { state: result.state, current: result.current })
			}
			case 'leave-zone': {
				const left = await leaveManagedZone({
					organization,
					managedDomainId: data.managedDomainId,
					actor,
				})
				return ok(intent, { domain: left.domain, zoneFile: left.text })
			}
			case 'export-zone': {
				const exported = await exportManagedZone(
					ctx.organization.id,
					data.managedDomainId,
				)
				return new Response(exported.text, {
					headers: {
						'Content-Type': 'text/plain; charset=utf-8',
						'Content-Disposition': `attachment; filename="${exported.domain.fqdn}.zone.txt"`,
						'Cache-Control': 'no-store',
					},
				})
			}
			case 'add-record':
				await addZoneRecord({
					organizationId: ctx.organization.id,
					managedDomainId: data.managedDomainId,
					record: {
						type: data.type,
						name: data.name,
						content: data.content,
						ttl: data.ttl,
						priority: data.priority,
					},
					actor,
				})
				return ok(intent)
			case 'update-record':
				await updateZoneRecord({
					organizationId: ctx.organization.id,
					managedDomainId: data.managedDomainId,
					recordId: data.recordId,
					record: {
						type: data.type,
						name: data.name,
						content: data.content,
						ttl: data.ttl,
						priority: data.priority,
					},
					actor,
				})
				return ok(intent)
			case 'delete-record':
				await deleteZoneRecord({
					organizationId: ctx.organization.id,
					managedDomainId: data.managedDomainId,
					recordId: data.recordId,
					actor,
				})
				return ok(intent)

			// ----- #183: buying and keeping a domain ------------------------------------
			case 'search-domains':
				return ok(
					intent,
					await searchDomains({
						organizationId: ctx.organization.id,
						query: data.query,
						city: data.city,
					}),
				)
			case 'buy-domain': {
				const started = await startPurchase({
					organization: { ...organization, name: ctx.organization.name },
					fqdn: data.fqdn,
					contact: contactOf(data),
					acceptedPriceCents: data.acceptedPriceCents,
					actor,
				})
				return ok(intent, { jobId: started.jobId })
			}
			case 'transfer-in': {
				const started = await startTransferIn({
					organization: { ...organization, name: ctx.organization.name },
					fqdn: data.fqdn,
					authCode: data.authCode,
					contact: contactOf(data),
					acceptedPriceCents: data.acceptedPriceCents,
					actor,
				})
				return ok(intent, { jobId: started.jobId, status: started.status })
			}
			case 'set-auto-renew':
				await setAutoRenew({
					organizationId: ctx.organization.id,
					managedDomainId: data.managedDomainId,
					autoRenew: data.autoRenew === 'true',
					actor,
				})
				return ok(intent)
			case 'transfer-out': {
				const result = await transferOut({
					organizationId: ctx.organization.id,
					managedDomainId: data.managedDomainId,
					actor,
				})
				return ok(intent, { authCode: result.authCode, fqdn: result.fqdn })
			}
			case 'lock-domain':
				await lockDomain({
					organizationId: ctx.organization.id,
					managedDomainId: data.managedDomainId,
				})
				return ok(intent)
			case 'resend-registrant-email':
				await resendRegistrantVerification({
					organizationId: ctx.organization.id,
					managedDomainId: data.managedDomainId,
				})
				return ok(intent)
			case 'confirm-registrant-email': {
				const confirmed = await confirmRegistrantEmail({
					organizationId: ctx.organization.id,
					managedDomainId: data.managedDomainId,
				})
				return confirmed ? ok(intent) : fail(intent, 'not_confirmed_yet', 409)
			}

			// ----- #276: forwarding -------------------------------------------------------
			case 'enable-forwarding':
				await enableForwarding({
					organizationId: ctx.organization.id,
					managedDomainId: data.managedDomainId,
					mxConfirmation: data.mxConfirmation,
					actor,
				})
				return ok(intent)
			case 'add-forward':
				await addForward({
					organizationId: ctx.organization.id,
					managedDomainId: data.managedDomainId,
					localPart: data.localPart,
					destination: data.destination,
					mxConfirmation: data.mxConfirmation,
					actor,
				})
				return ok(intent)
			case 'remove-forward':
				await removeForward({
					organizationId: ctx.organization.id,
					managedDomainId: data.managedDomainId,
					forwardId: data.forwardId,
					actor,
				})
				return ok(intent)
			case 'resend-forward-confirmation':
				await resendConfirmation({
					organizationId: ctx.organization.id,
					managedDomainId: data.managedDomainId,
					forwardId: data.forwardId,
				})
				return ok(intent)
			case 'check-forwarding': {
				const [row] = await db
					.select()
					.from(ManagedDomain)
					.where(eq(ManagedDomain.id, data.managedDomainId))
				if (!row || row.organizationId !== ctx.organization.id)
					return fail(intent, 'not_found', 404)
				return ok(intent, await refreshForwarding(row))
			}
			case 'disable-forwarding':
				await disableForwarding({
					organizationId: ctx.organization.id,
					managedDomainId: data.managedDomainId,
					actor,
				})
				return ok(intent)
		}
	} catch (error) {
		return answerError(intent, error)
	}
}
