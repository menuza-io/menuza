import { and, count, desc, eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import {
	getTenantDb,
	websiteForms,
	websiteFormSubmissions,
} from '@repo/tenant-db'
import { z } from 'zod'

import { resolveOrganizationForBrowserAuth } from '../lib/origin.ts'
import { authenticateOperator } from './operator.ts'

export const publicFormRoutes = new Hono()
export const formOperatorRoutes = new Hono()

const fieldSchema = z.object({
	id: z.string().min(1).max(50),
	label: z.string().min(1).max(100),
	type: z.enum(['text', 'email', 'tel', 'textarea']),
	required: z.boolean().default(false),
})

const formSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).optional().default(''),
	fields: z.array(fieldSchema).min(1).max(20),
	submitLabel: z.string().trim().min(1).max(50).default('Submit'),
	successMessage: z.string().trim().min(1).max(300),
	status: z.enum(['draft', 'published']).default('published'),
})

const publicIdentitySchema = z.object({
	slug: z.string().optional(),
	host: z.string().optional(),
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

	const values: Record<string, string> = {}
	for (const field of fields) {
		const value = String(rawValues.data[field.id] ?? '').trim()
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
