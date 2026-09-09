import { and, count, desc, eq, lt, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import {
	getTenantDb,
	websiteForms,
	websiteFormSubmissions,
} from '@repo/tenant-db'
import {
	publicFormFieldObjectSchema,
	publicFormFieldsSchema,
	validatePublicFormFieldChoices,
} from '@repo/common/public-form'
import { parseLocalizedString } from '@repo/common/site-locales'
import {
	isTurnstileConfigured,
	parseTurnstileHostnames,
	verifyTurnstileToken,
} from '@repo/common/turnstile'
import { ENV } from 'varlock/env'
import { z } from 'zod'

import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import { authenticateOperator } from './operator.ts'

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

function submissionClientIp(c: Context) {
	const forwardedFor = c.req.header('x-forwarded-for')
	const fromForwarded = forwardedFor?.split(',')[0]?.trim()
	return fromForwarded || c.req.header('cf-connecting-ip') || undefined
}

async function verifyFormTurnstile(c: Context, token: unknown) {
	const secret = ENV.TURNSTILE_SECRET_KEY ?? ''
	if (!isTurnstileConfigured(secret)) return true
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
	return form ? c.json({ form }) : c.json({ error: 'Form not found' }, 404)
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

	const optionLabels = (option: string) => {
		const localized = parseLocalizedString(option)
		const labels = Object.values(localized)
			.map((label) => label?.trim())
			.filter(Boolean) as string[]
		return labels.length > 0 ? labels : [option.trim()]
	}
	const isValidChoice = (choice: string, options: string[]) =>
		options.some((option) => optionLabels(option).includes(choice.trim()))

	const values: Record<string, string> = {}
	for (const field of fields) {
		if (field.type === 'heading' || field.type === 'paragraph') continue
		const raw = rawValues.data[field.id]
		if (field.type === 'multiple_choice') {
			const selected = Array.isArray(raw)
				? raw
						.map(String)
						.map((choice) => choice.trim())
						.filter(Boolean)
				: typeof raw === 'string'
					? raw
							.split(',')
							.map((choice) => choice.trim())
							.filter(Boolean)
					: []
			if (field.required && selected.length === 0) {
				return c.json({ error: `${field.label} is required` }, 400)
			}
			if (
				selected.some(
					(choice) =>
						!(field.options ?? []).length ||
						!isValidChoice(choice, field.options ?? []),
				)
			) {
				return c.json(
					{ error: `${field.label} contains an invalid choice` },
					400,
				)
			}
			const serialized = selected.join(', ')
			if (serialized.length > 5000) {
				return c.json({ error: 'Value is too long' }, 400)
			}
			values[field.id] = serialized
			continue
		}

		if (Array.isArray(raw)) {
			return c.json({ error: `${field.label} must be a single value` }, 400)
		}
		const value = String(raw ?? '').trim()
		if (field.required && !value) {
			return c.json({ error: `${field.label} is required` }, 400)
		}
		if (value.length > 5000) return c.json({ error: 'Value is too long' }, 400)
		if (
			field.type === 'email' &&
			value &&
			!z.string().email().safeParse(value).success
		) {
			return c.json({ error: `${field.label} must be a valid email` }, 400)
		}
		if (
			field.type === 'single_choice' &&
			value &&
			!isValidChoice(value, field.options ?? [])
		) {
			return c.json({ error: `${field.label} contains an invalid choice` }, 400)
		}
		values[field.id] = value
	}

	await db.insert(websiteFormSubmissions).values({ formId: form.id, values })
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
	try {
		orgId = (await authenticateOperator(c)).orgId
	} catch (response) {
		return response as Response
	}
	const parsed = formSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.issues[0]?.message ?? 'Invalid form' },
			400,
		)
	}
	const db = await getTenantDb(orgId)
	const [form] = await db.insert(websiteForms).values(parsed.data).returning()
	return c.json({ form }, 201)
})

formOperatorRoutes.put('/:formId', async (c) => {
	let orgId: string
	try {
		orgId = (await authenticateOperator(c)).orgId
	} catch (response) {
		return response as Response
	}
	const parsed = formSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.issues[0]?.message ?? 'Invalid form' },
			400,
		)
	}
	const db = await getTenantDb(orgId)
	const [form] = await db
		.update(websiteForms)
		.set({ ...parsed.data, updatedAt: sql`(strftime('%s', 'now'))` })
		.where(eq(websiteForms.id, c.req.param('formId')))
		.returning()
	return form ? c.json({ form }) : c.json({ error: 'Form not found' }, 404)
})

formOperatorRoutes.get('/:formId/submissions', async (c) => {
	let orgId: string
	try {
		orgId = (await authenticateOperator(c)).orgId
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
	try {
		orgId = (await authenticateOperator(c)).orgId
	} catch (response) {
		return response as Response
	}
	const db = await getTenantDb(orgId)
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
	try {
		orgId = (await authenticateOperator(c)).orgId
	} catch (response) {
		return response as Response
	}
	const db = await getTenantDb(orgId)
	const deleted = await db
		.delete(websiteForms)
		.where(eq(websiteForms.id, c.req.param('formId')))
		.returning({ id: websiteForms.id })
	return deleted.length
		? c.json({ success: true })
		: c.json({ error: 'Form not found' }, 404)
})
