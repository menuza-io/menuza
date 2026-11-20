import { and, count, desc, eq, lt, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import {
	formResponseOutbox,
	getTenantDb,
	runTenantTransaction,
	websiteForms,
	websiteFormSubmissions,
} from '@repo/tenant-db'
import { formNotifySchema } from '@repo/common/form-alerts'
import {
	publicFormFieldObjectSchema,
	publicFormFieldsSchema,
	validatePublicFormFieldChoices,
} from '@repo/common/public-form'
import { validateFormSubmission } from '@repo/common/public-form-submission'
import {
	isTurnstileConfigured,
	parseTurnstileHostnames,
	verifyTurnstileToken,
} from '@repo/common/turnstile'
import { ENV } from 'varlock/env'
import { z } from 'zod'

import { runInBackground } from '../lib/background.ts'
import { clientAddress } from '../lib/client-ip.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import { drainFormResponseOutbox } from '../services/form-response-outbox.ts'
import {
	popupSignupSchema,
	recordPopupSignup,
} from '../services/popup-signup.ts'
import { siteEventBodySchema } from '@repo/common/site-funnel'
import { countSiteEvent, siteEventsDisabled } from '../services/site-events.ts'
import { authenticateOperator, requireOperatorClaim } from './operator.ts'

export const publicFormRoutes = new Hono()
export const formOperatorRoutes = new Hono()
export const formSystemRoutes = new Hono()

const fieldSchema = publicFormFieldObjectSchema
	.extend({
		required: z.boolean().default(false),
	})
	.superRefine(validatePublicFormFieldChoices)
const fieldsArraySchema = publicFormFieldsSchema

const formSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).optional().default(''),
	fields: fieldsArraySchema,
	submitLabel: z.string().trim().min(1).max(50).default('Submit'),
	successMessage: z.string().trim().min(1).max(300),
	status: z.enum(['draft', 'published']).default('published'),
	/** Restricted form (#357): responses need `read:form_restricted:any`. */
	restricted: z.boolean().optional(),
	/** Who hears about a new response (#142); `null` means every member. */
	notify: formNotifySchema.nullable().optional(),
})

const publicIdentitySchema = z.object({
	slug: z.string().optional(),
	host: z.string().optional(),
})

const retentionPurgeSchema = z.object({
	orgId: z.string().min(1),
	retentionDays: z.number().int().min(1).max(3650).default(365),
})

const TURNSTILE_FORM_ACTION = 'website-form'

/** The `restrictedForms` claim, minted only for `read:form_restricted:any`. */
function canReadRestrictedForms(auth: { restrictedForms?: boolean }) {
	return auth.restrictedForms === true
}

async function isRestrictedAndClosed(
	db: Awaited<ReturnType<typeof getTenantDb>>,
	formId: string,
	auth: { restrictedForms?: boolean },
) {
	if (canReadRestrictedForms(auth)) return false
	const [row] = await db
		.select({ restricted: websiteForms.restricted })
		.from(websiteForms)
		.where(eq(websiteForms.id, formId))
		.limit(1)
	return row?.restricted === true
}

function submissionClientIp(c: Context) {
	return clientAddress(c) ?? undefined
}

async function verifyFormTurnstile(c: Context, token: unknown) {
	const secret = ENV.TURNSTILE_SECRET_KEY ?? ''
	// Off only for an explicit local NODE_ENV (see careers.ts).
	if (!isTurnstileConfigured(secret)) {
		return ENV.NODE_ENV === 'development' || ENV.NODE_ENV === 'test'
	}
	if (typeof token !== 'string' || !token.trim()) return false
	const result = await verifyTurnstileToken({
		secret,
		token,
		remoteIp: submissionClientIp(c),
		expectedAction: TURNSTILE_FORM_ACTION,
		expectedHostnames: parseTurnstileHostnames(ENV.TURNSTILE_HOSTNAMES),
	})
	return result.success
}

formSystemRoutes.post('/purge-submissions', async (c) => {
	const internalToken = getInternalCommandToken()
	const presented = getBearerToken(c.req.header('Authorization'))
	if (
		internalToken.length < 16 ||
		!presented ||
		!timingSafeEqualString(presented, internalToken)
	) {
		return c.json({ error: 'Unauthorized' }, 401)
	}

	const parsed = retentionPurgeSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) return c.json({ error: 'Invalid purge request' }, 400)
	const organization = await findActiveOrganizationById(parsed.data.orgId)
	if (!organization || !orgMatchesNodeRegion(organization.dataRegion)) {
		return c.json(
			{ error: 'Organization is not available in this region' },
			404,
		)
	}

	const cutoff = new Date(
		Date.now() - parsed.data.retentionDays * 24 * 60 * 60 * 1000,
	)
	const db = await getTenantDb(organization.id)
	const deleted = await db
		.delete(websiteFormSubmissions)
		.where(lt(websiteFormSubmissions.createdAt, cutoff))
	return c.json({ success: true, deleted: deleted.rowsAffected, cutoff })
})

async function publicOrganization(c: Context) {
	const parsed = publicIdentitySchema.safeParse({
		slug: c.req.query('slug'),
		host: c.req.query('host'),
	})
	if (!parsed.success) return null
	return resolveOrganizationForBrowserAuth(c.req.header('Origin'), parsed.data)
}

/**
 * `POST /forms/popup-signup` (#132): a contact left in a website popup, with
 * explicit consent, stored in this region only. Honeypot, Turnstile and a
 * per-address limit like every public form; the organization comes from the
 * browser `Origin`.
 */
publicFormRoutes.post(
	'/popup-signup',
	rateLimit('popup-signup', { windowMs: 10 * 60 * 1000, maxRequests: 10 }),
	async (c) => {
		const body = await c.req.json().catch(() => null)
		if ((body as { website?: unknown } | null)?.website) {
			return c.json({ success: true }, 201)
		}
		const parsed = popupSignupSchema.safeParse(body)
		if (!parsed.success) return c.json({ error: 'Invalid signup' }, 400)
		if (!(await verifyFormTurnstile(c, parsed.data.turnstileToken))) {
			return c.json({ error: 'Verification failed. Please try again.' }, 403)
		}
		const organization = await resolveOrganizationForBrowserAuth(
			c.req.header('Origin'),
			{ slug: parsed.data.slug, host: parsed.data.host },
		)
		if (!organization) return c.json({ error: 'Not found' }, 404)
		const result = await recordPopupSignup(organization.id, parsed.data)
		if (!result.ok) return c.json({ error: result.error }, 400)
		return c.json({ success: true }, 201)
	},
)

/**
 * `POST /forms/site-events` (#179, #338): one funnel count from the visitor's
 * browser. The body names an event, a device class, how the visit started and
 * (in a test) the arm: nothing that identifies a person, and nothing about the
 * person is stored. The organization comes from the browser `Origin`.
 * Always answers 204, so a blocked, switched-off or malformed beacon is silent
 * for the visitor. `SITE_EVENTS_ENABLED=false` stops counting on this node.
 */
publicFormRoutes.post(
	'/site-events',
	rateLimit('site-events', { windowMs: 60 * 1000, maxRequests: 120 }),
	async (c) => {
		if (siteEventsDisabled()) return c.body(null, 204)
		const parsed = siteEventBodySchema.safeParse(
			await c.req.json().catch(() => null),
		)
		if (!parsed.success) return c.body(null, 204)
		const organization = await resolveOrganizationForBrowserAuth(
			c.req.header('Origin'),
			{ slug: parsed.data.slug, host: parsed.data.host },
		)
		if (!organization) return c.body(null, 204)
		await countSiteEvent(organization.id, parsed.data).catch(() => {})
		return c.body(null, 204)
	},
)

publicFormRoutes.get('/:formId', async (c) => {
	const organization = await publicOrganization(c)
	if (!organization) return c.json({ error: 'Form not found' }, 404)

	const db = await getTenantDb(organization.id)
	const [form] = await db
		.select()
		.from(websiteForms)
		.where(
			and(
				eq(websiteForms.id, c.req.param('formId')),
				eq(websiteForms.status, 'published'),
			),
		)
		.limit(1)
	if (!form) return c.json({ error: 'Form not found' }, 404)
	// `notify` names operators and `restricted` is internal: neither is public.
	const {
		notify: ignoredNotify,
		restricted: ignoredRestricted,
		...publicForm
	} = form
	return c.json({ form: publicForm })
})

publicFormRoutes.post('/:formId/submissions', async (c) => {
	const body = await c.req.json().catch(() => null)
	if ((body as { website?: unknown } | null)?.website) {
		return c.json({ success: true }, 201)
	}
	if (
		!(await verifyFormTurnstile(
			c,
			(body as { turnstileToken?: unknown })?.turnstileToken,
		))
	) {
		return c.json({ error: 'Verification failed. Please try again.' }, 403)
	}
	const identity = publicIdentitySchema.safeParse(body)
	if (!identity.success) return c.json({ error: 'Invalid submission' }, 400)
	const organization = await resolveOrganizationForBrowserAuth(
		c.req.header('Origin'),
		identity.data,
	)
	if (!organization) return c.json({ error: 'Form not found' }, 404)

	const db = await getTenantDb(organization.id)
	const [form] = await db
		.select()
		.from(websiteForms)
		.where(
			and(
				eq(websiteForms.id, c.req.param('formId')),
				eq(websiteForms.status, 'published'),
			),
		)
		.limit(1)
	if (!form) return c.json({ error: 'Form not found' }, 404)

	const fields = z.array(fieldSchema).parse(form.fields)
	const rawValues = z
		.record(z.string(), z.unknown())
		.safeParse((body as { values?: unknown })?.values)
	if (!rawValues.success) return c.json({ error: 'Invalid submission' }, 400)
	const unavailable = z
		.array(z.string().max(50))
		.max(20)
		.safeParse((body as { unavailableFields?: unknown })?.unavailableFields)

	const labels = z
		.record(z.string().max(50), z.string().max(100))
		.safeParse((body as { locationLabels?: unknown })?.locationLabels)

	// Hidden fields are dropped and never required (#357); address and location
	// answers are checked against the definition (#239).
	const result = validateFormSubmission(fields, rawValues.data, {
		unavailableLocationFields: unavailable.success ? unavailable.data : [],
		locationLabels: labels.success ? labels.data : {},
	})
	if (!result.ok) return c.json({ error: result.error }, 400)
	const values = result.values

	// The response and its alert event commit together, so only a stored
	// response ever notifies (spam-blocked submissions returned above).
	await runTenantTransaction(db, async (tx) => {
		await tx.insert(websiteFormSubmissions).values({ formId: form.id, values })
		await tx.insert(formResponseOutbox).values({ formId: form.id })
	})
	runInBackground(drainFormResponseOutbox(organization.id, { db }))
	return c.json({ success: true, message: form.successMessage }, 201)
})

formOperatorRoutes.get('/', async (c) => {
	let orgId: string
	try {
		orgId = (await authenticateOperator(c)).orgId
	} catch (response) {
		return response as Response
	}
	const db = await getTenantDb(orgId)
	const forms = await db
		.select({
			id: websiteForms.id,
			name: websiteForms.name,
			description: websiteForms.description,
			fields: websiteForms.fields,
			status: websiteForms.status,
			restricted: websiteForms.restricted,
			notify: websiteForms.notify,
			createdAt: websiteForms.createdAt,
			updatedAt: websiteForms.updatedAt,
			submissionCount: count(websiteFormSubmissions.id),
		})
		.from(websiteForms)
		.leftJoin(
			websiteFormSubmissions,
			eq(websiteFormSubmissions.formId, websiteForms.id),
		)
		.groupBy(websiteForms.id)
		.orderBy(desc(websiteForms.updatedAt))
	return c.json({ forms })
})

formOperatorRoutes.post('/', async (c) => {
	let orgId: string
	let auth
	try {
		auth = await authenticateOperator(c)
		orgId = auth.orgId
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied
	const parsed = formSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.issues[0]?.message ?? 'Invalid form' },
			400,
		)
	}
	// Marking a form restricted is allowed to anyone who can edit forms; only a
	// holder of `read:form_restricted:any` can lift it again (#357).
	const db = await getTenantDb(orgId)
	const { notify, restricted, ...rest } = parsed.data
	const [form] = await db
		.insert(websiteForms)
		.values({
			...rest,
			restricted: restricted ?? false,
			notify: notify ?? null,
		})
		.returning()
	return c.json({ form }, 201)
})

formOperatorRoutes.put('/:formId', async (c) => {
	let orgId: string
	let auth
	try {
		auth = await authenticateOperator(c)
		orgId = auth.orgId
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied
	const parsed = formSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.issues[0]?.message ?? 'Invalid form' },
			400,
		)
	}
	const db = await getTenantDb(orgId)
	const formId = c.req.param('formId')
	const { notify, restricted, ...rest } = parsed.data
	const [current] = await db
		.select({ restricted: websiteForms.restricted })
		.from(websiteForms)
		.where(eq(websiteForms.id, formId))
		.limit(1)
	if (!current) return c.json({ error: 'Form not found' }, 404)
	// Editing a restricted form stays open to form editors; lifting the
	// restriction needs `read:form_restricted:any` (#357).
	if (
		current.restricted &&
		restricted === false &&
		!canReadRestrictedForms(auth)
	) {
		return c.json({ error: 'restricted_form' }, 403)
	}
	const [form] = await db
		.update(websiteForms)
		.set({
			...rest,
			...(restricted === undefined ? {} : { restricted }),
			...(notify === undefined ? {} : { notify }),
			updatedAt: sql`(strftime('%s', 'now'))`,
		})
		.where(eq(websiteForms.id, formId))
		.returning()
	return form ? c.json({ form }) : c.json({ error: 'Form not found' }, 404)
})

formOperatorRoutes.get('/:formId/submissions', async (c) => {
	let orgId: string
	let auth
	try {
		auth = await authenticateOperator(c)
		orgId = auth.orgId
	} catch (response) {
		return response as Response
	}
	const db = await getTenantDb(orgId)
	const [form] = await db
		.select()
		.from(websiteForms)
		.where(eq(websiteForms.id, c.req.param('formId')))
		.limit(1)
	if (!form) return c.json({ error: 'Form not found' }, 404)
	// A restricted form's responses are readable only with the claim (#357).
	if (form.restricted && !canReadRestrictedForms(auth)) {
		return c.json({ error: 'restricted_form' }, 403)
	}
	const submissions = await db
		.select()
		.from(websiteFormSubmissions)
		.where(eq(websiteFormSubmissions.formId, form.id))
		.orderBy(desc(websiteFormSubmissions.createdAt))
		.limit(500)
	return c.json({ form, submissions })
})

formOperatorRoutes.delete('/:formId/submissions/:submissionId', async (c) => {
	let orgId: string
	let auth
	try {
		auth = await authenticateOperator(c)
		orgId = auth.orgId
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canDelete')
	if (denied) return denied
	const db = await getTenantDb(orgId)
	if (await isRestrictedAndClosed(db, c.req.param('formId'), auth)) {
		return c.json({ error: 'restricted_form' }, 403)
	}
	const deleted = await db
		.delete(websiteFormSubmissions)
		.where(
			and(
				eq(websiteFormSubmissions.id, c.req.param('submissionId')),
				eq(websiteFormSubmissions.formId, c.req.param('formId')),
			),
		)
		.returning({ id: websiteFormSubmissions.id })
	return deleted.length
		? c.json({ success: true })
		: c.json({ error: 'Submission not found' }, 404)
})

formOperatorRoutes.delete('/:formId', async (c) => {
	let orgId: string
	let auth
	try {
		auth = await authenticateOperator(c)
		orgId = auth.orgId
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canDelete')
	if (denied) return denied
	const db = await getTenantDb(orgId)
	// Deleting a restricted form deletes its responses: readers only (#357).
	if (await isRestrictedAndClosed(db, c.req.param('formId'), auth)) {
		return c.json({ error: 'restricted_form' }, 403)
	}
	const deleted = await db
		.delete(websiteForms)
		.where(eq(websiteForms.id, c.req.param('formId')))
		.returning({ id: websiteForms.id })
	return deleted.length
		? c.json({ success: true })
		: c.json({ error: 'Form not found' }, 404)
})
