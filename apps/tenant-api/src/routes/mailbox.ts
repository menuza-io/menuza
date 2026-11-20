import { and, count, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { mailboxRecipient } from '@repo/common/mailbox'
import {
	publicFormDisplayFieldTypes,
	publicFormFieldsSchema,
} from '@repo/common/public-form'
import { toCsv } from '@repo/staffing'
import {
	formExportAudit,
	getTenantDb,
	mailboxReadReceipts,
	websiteForms,
	websiteFormSubmissions,
} from '@repo/tenant-db'
import { z } from 'zod'
import {
	draftGoogleReviewReply,
	draftMailboxReply,
	isMailboxAIConfigured,
} from '../lib/mailbox-ai.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { authenticateOperator } from './operator.ts'

export const mailboxRoutes = new Hono<{
	Variables: {
		operator: { orgId: string; sub: string; restrictedForms: boolean }
	}
}>()

/** The most rows one export file holds (#142). */
export const FORM_EXPORT_MAX_ROWS = 10_000

mailboxRoutes.use('*', async (c, next) => {
	try {
		const auth = await authenticateOperator(c, 'mailbox')
		if (typeof auth.sub !== 'string' || !auth.sub)
			return c.json({ error: 'Unauthorized' }, 401)
		const organization = await findActiveOrganizationById(auth.orgId)
		if (!organization) {
			return c.json({ error: 'Organization not found' }, 404)
		}
		if (!orgMatchesNodeRegion(organization.dataRegion)) {
			return c.json({ error: 'Mailbox is not available in this region' }, 404)
		}
		c.set('operator', {
			orgId: auth.orgId,
			sub: auth.sub,
			// Minted only for `read:form_restricted:any` (#357).
			restrictedForms: auth.restrictedForms === true,
		})
	} catch (response) {
		if (response instanceof Response) return response
		throw response
	}
	c.header('Cache-Control', 'private, no-store')
	await next()
})

/**
 * Without the `restrictedForms` claim a restricted form's responses are not
 * listed, counted, searched, marked read, drafted against or exported (#357).
 */
function restrictedGate(operator: { restrictedForms: boolean }) {
	return operator.restrictedForms
		? undefined
		: eq(websiteForms.restricted, false)
}

function readJoin(operatorId: string) {
	return and(
		eq(mailboxReadReceipts.submissionId, websiteFormSubmissions.id),
		eq(mailboxReadReceipts.operatorId, operatorId),
	)
}

mailboxRoutes.get('/ai/status', (c) =>
	c.json({ aiAvailable: isMailboxAIConfigured() }),
)

const googleReviewDraftSchema = z.object({
	location: z.string().trim().min(1).max(200),
	reviewer: z.string().trim().max(200).default(''),
	starRating: z.enum(['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE']).optional(),
	review: z.string().trim().max(3000).default(''),
	notes: z.string().trim().max(2000).default(''),
	platform: z.string().trim().max(100).optional(),
})

mailboxRoutes.post(
	'/reviews/draft',
	rateLimit('mailbox-ai', { windowMs: 60000, maxRequests: 10 }),
	async (c) => {
		const parsed = googleReviewDraftSchema.safeParse(
			await c.req.json().catch(() => null),
		)
		if (!parsed.success)
			return c.json({ error: 'Invalid review drafting details.' }, 400)
		if (!isMailboxAIConfigured())
			return c.json(
				{ error: 'AI drafting is not configured for this mailbox.' },
				503,
			)
		try {
			const reply = await draftGoogleReviewReply(parsed.data)
			return c.json({ reply })
		} catch {
			return c.json(
				{
					error:
						'Could not create a reply suggestion. Try again or write your reply.',
				},
				502,
			)
		}
	},
)

mailboxRoutes.get('/count', async (c) => {
	const auth = c.get('operator')
	const db = await getTenantDb(auth.orgId)
	const [result] = await db
		.select({ value: count() })
		.from(websiteFormSubmissions)
		.innerJoin(websiteForms, eq(websiteForms.id, websiteFormSubmissions.formId))
		.leftJoin(mailboxReadReceipts, readJoin(auth.sub))
		.where(and(isNull(mailboxReadReceipts.submissionId), restrictedGate(auth)))
	return c.json({ unreadCount: result?.value ?? 0 })
})

const listQuerySchema = z.object({
	page: z.coerce.number().int().min(1).max(100000).default(1),
	search: z.string().trim().max(200).default(''),
	unread: z.enum(['true', 'false']).default('false'),
})

mailboxRoutes.get('/forms', async (c) => {
	const parsed = listQuerySchema.safeParse(c.req.query())
	if (!parsed.success) return c.json({ error: 'Invalid mailbox filters' }, 400)
	const auth = c.get('operator')
	const db = await getTenantDb(auth.orgId)
	const { page, search, unread } = parsed.data
	const where = and(
		restrictedGate(auth),
		unread === 'true' ? isNull(mailboxReadReceipts.submissionId) : undefined,
		search
			? sql`(instr(lower(${websiteForms.name}), lower(${search})) > 0 or exists (select 1 from json_each(${websiteFormSubmissions.values}) where type = 'text' and instr(lower(value), lower(${search})) > 0))`
			: undefined,
	)
	const [result] = await db
		.select({ value: count() })
		.from(websiteFormSubmissions)
		.innerJoin(websiteForms, eq(websiteForms.id, websiteFormSubmissions.formId))
		.leftJoin(mailboxReadReceipts, readJoin(auth.sub))
		.where(where)
	const [unreadResult] = await db
		.select({ value: count() })
		.from(websiteFormSubmissions)
		.innerJoin(websiteForms, eq(websiteForms.id, websiteFormSubmissions.formId))
		.leftJoin(mailboxReadReceipts, readJoin(auth.sub))
		.where(and(isNull(mailboxReadReceipts.submissionId), restrictedGate(auth)))
	// What a member without the grant still sees of restricted forms: that they
	// exist and how many responses they hold, never an answer (#357).
	const lockedForms = auth.restrictedForms
		? []
		: await db
				.select({
					id: websiteForms.id,
					name: websiteForms.name,
					responseCount: count(websiteFormSubmissions.id),
				})
				.from(websiteForms)
				.leftJoin(
					websiteFormSubmissions,
					eq(websiteFormSubmissions.formId, websiteForms.id),
				)
				.where(eq(websiteForms.restricted, true))
				.groupBy(websiteForms.id)
	const rows = await db
		.select({
			id: websiteFormSubmissions.id,
			formId: websiteFormSubmissions.formId,
			formName: websiteForms.name,
			restricted: websiteForms.restricted,
			fields: websiteForms.fields,
			values: websiteFormSubmissions.values,
			createdAt: websiteFormSubmissions.createdAt,
			readAt: mailboxReadReceipts.readAt,
		})
		.from(websiteFormSubmissions)
		.innerJoin(websiteForms, eq(websiteForms.id, websiteFormSubmissions.formId))
		.leftJoin(mailboxReadReceipts, readJoin(auth.sub))
		.where(where)
		.orderBy(
			desc(websiteFormSubmissions.createdAt),
			desc(websiteFormSubmissions.id),
		)
		.limit(50)
		.offset((page - 1) * 50)
	return c.json({
		items: rows.map(({ readAt, fields, ...item }) => ({
			...item,
			fields: publicFormFieldsSchema.parse(fields),
			isRead: Boolean(readAt),
		})),
		total: result?.value ?? 0,
		unreadCount: unreadResult?.value ?? 0,
		lockedForms,
		canReadRestricted: auth.restrictedForms,
		aiAvailable: isMailboxAIConfigured(),
	})
})

mailboxRoutes.put('/forms/:submissionId/read', async (c) => {
	const parsed = z
		.object({ read: z.boolean() })
		.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return c.json({ error: 'Invalid read status' }, 400)
	const auth = c.get('operator')
	const db = await getTenantDb(auth.orgId)
	const id = c.req.param('submissionId') || ''
	const [submission] = await db
		.select({ id: websiteFormSubmissions.id })
		.from(websiteFormSubmissions)
		.innerJoin(websiteForms, eq(websiteForms.id, websiteFormSubmissions.formId))
		.where(and(eq(websiteFormSubmissions.id, id), restrictedGate(auth)))
		.limit(1)
	if (!submission) return c.json({ error: 'Submission not found' }, 404)
	if (parsed.data.read) {
		await db
			.insert(mailboxReadReceipts)
			.values({ submissionId: id, operatorId: auth.sub, readAt: new Date() })
			.onConflictDoNothing()
	} else {
		await db
			.delete(mailboxReadReceipts)
			.where(
				and(
					eq(mailboxReadReceipts.submissionId, id),
					eq(mailboxReadReceipts.operatorId, auth.sub),
				),
			)
	}
	return c.json({ success: true })
})

mailboxRoutes.post(
	'/forms/:submissionId/draft',
	rateLimit('mailbox-ai', { windowMs: 60000, maxRequests: 10 }),
	async (c) => {
		const parsed = z
			.object({ notes: z.string().trim().max(2000).default('') })
			.safeParse(await c.req.json().catch(() => null))
		if (!parsed.success)
			return c.json({ error: 'Invalid drafting instructions' }, 400)
		if (!isMailboxAIConfigured())
			return c.json(
				{ error: 'AI drafting is not configured for this mailbox.' },
				503,
			)
		const db = await getTenantDb(c.get('operator').orgId)
		const [row] = await db
			.select({ submission: websiteFormSubmissions, form: websiteForms })
			.from(websiteFormSubmissions)
			.innerJoin(
				websiteForms,
				eq(websiteForms.id, websiteFormSubmissions.formId),
			)
			.where(
				and(
					eq(websiteFormSubmissions.id, c.req.param('submissionId') || ''),
					restrictedGate(c.get('operator')),
				),
			)
			.limit(1)
		if (!row) return c.json({ error: 'Submission not found' }, 404)
		const item = {
			values: z.record(z.string(), z.string()).parse(row.submission.values),
			fields: publicFormFieldsSchema.parse(row.form.fields),
		}
		if (!mailboxRecipient(item))
			return c.json({ error: 'This submission has no email address.' }, 400)
		try {
			const message = await draftMailboxReply({
				form: row.form.name,
				answers: item.fields
					.filter(
						(field) =>
							field.type !== 'heading' &&
							field.type !== 'paragraph' &&
							field.type !== 'email' &&
							field.type !== 'tel' &&
							field.type !== 'name',
					)
					.map((field) => ({
						question: field.label,
						answer: item.values[field.id]?.slice(0, 2000),
					}))
					.slice(0, 20),
				notes: parsed.data.notes,
			})
			return c.json({ message })
		} catch {
			return c.json(
				{ error: 'Could not create a draft. Try again or write your reply.' },
				502,
			)
		}
	},
)

const exportQuerySchema = z.object({
	from: z.string().max(40).optional(),
	to: z.string().max(40).optional(),
})

/** A date (`2026-03-01`) or an instant, as the start of a range; null when unreadable. */
function parseRangeBound(raw: string | undefined, endOfDay: boolean) {
	if (!raw) return undefined
	const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw)
	const time = Date.parse(dateOnly ? `${raw}T00:00:00.000Z` : raw)
	if (!Number.isFinite(time)) return null
	return new Date(time + (dateOnly && endOfDay ? 24 * 60 * 60 * 1000 : 0))
}

/**
 * `GET /operator/mailbox/forms/:formId/export?from=&to=` (#142): the form's
 * responses as a CSV, straight from the region to the browser (App never sees
 * the file). Columns are the form's fields in order, then the time submitted
 * and this operator's read status. Cells are formula-safe, the file is capped
 * at 10,000 rows (a larger range is refused so the operator picks a smaller
 * one), and every export writes an audit row with the form id and a count,
 * never a value. A restricted form needs the `restrictedForms` claim.
 */
mailboxRoutes.get('/forms/:formId/export', async (c) => {
	const query = exportQuerySchema.safeParse(c.req.query())
	if (!query.success) return c.json({ error: 'Invalid export range' }, 400)
	const from = parseRangeBound(query.data.from, false)
	const to = parseRangeBound(query.data.to, true)
	if (from === null || to === null) {
		return c.json({ error: 'Invalid export range' }, 400)
	}
	const auth = c.get('operator')
	const db = await getTenantDb(auth.orgId)
	const [form] = await db
		.select()
		.from(websiteForms)
		.where(eq(websiteForms.id, c.req.param('formId')))
		.limit(1)
	if (!form) return c.json({ error: 'Form not found' }, 404)
	if (form.restricted && !auth.restrictedForms) {
		return c.json({ error: 'restricted_form' }, 403)
	}
	const where = and(
		eq(websiteFormSubmissions.formId, form.id),
		from ? gte(websiteFormSubmissions.createdAt, from) : undefined,
		to ? lt(websiteFormSubmissions.createdAt, to) : undefined,
	)
	const [total] = await db
		.select({ value: count() })
		.from(websiteFormSubmissions)
		.where(where)
	if ((total?.value ?? 0) > FORM_EXPORT_MAX_ROWS) {
		return c.json(
			{
				error: 'export_too_large',
				message: `This range holds more than ${FORM_EXPORT_MAX_ROWS} responses. Choose a smaller range.`,
			},
			413,
		)
	}
	const rows = await db
		.select({
			values: websiteFormSubmissions.values,
			createdAt: websiteFormSubmissions.createdAt,
			readAt: mailboxReadReceipts.readAt,
		})
		.from(websiteFormSubmissions)
		.leftJoin(mailboxReadReceipts, readJoin(auth.sub))
		.where(where)
		.orderBy(
			desc(websiteFormSubmissions.createdAt),
			desc(websiteFormSubmissions.id),
		)
		.limit(FORM_EXPORT_MAX_ROWS)
	const fields = publicFormFieldsSchema
		.parse(form.fields)
		.filter(
			(field) =>
				!(publicFormDisplayFieldTypes as readonly string[]).includes(
					field.type,
				),
		)
	const headers = [
		...fields.map((field) => localizedLabel(field.label)),
		'Submitted at',
		'Read',
	]
	const csv = toCsv(
		headers,
		rows.map((row) => {
			const values = z.record(z.string(), z.unknown()).parse(row.values)
			return [
				...fields.map((field) => {
					const value = values[field.id]
					return typeof value === 'string' ? value : ''
				}),
				row.createdAt ? row.createdAt.toISOString() : '',
				row.readAt ? 'read' : 'unread',
			]
		}),
		{ bom: true },
	)
	await db.insert(formExportAudit).values({
		kind: 'form_responses',
		targetId: form.id,
		operatorId: auth.sub,
		rowCount: rows.length,
	})
	return new Response(csv, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="form-${form.id.slice(0, 8)}-responses.csv"`,
			'Cache-Control': 'private, no-store',
			'X-Export-Rows': String(rows.length),
		},
	})
})

/** A field label is localized JSON; the file takes the first language. */
function localizedLabel(label: string): string {
	if (!label.trim().startsWith('{')) return label
	try {
		const parsed = JSON.parse(label) as Record<string, unknown>
		const first = Object.values(parsed).find(
			(value): value is string =>
				typeof value === 'string' && value.trim() !== '',
		)
		return parsed.en && typeof parsed.en === 'string'
			? parsed.en
			: (first ?? label)
	} catch {
		return label
	}
}
