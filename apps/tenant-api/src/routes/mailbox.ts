import { and, count, desc, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { mailboxRecipient } from '@repo/common/mailbox'
import { publicFormFieldsSchema } from '@repo/common/public-form'
import {
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
	Variables: { operator: { orgId: string; sub: string } }
}>()

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
		c.set('operator', { orgId: auth.orgId, sub: auth.sub })
	} catch (response) {
		if (response instanceof Response) return response
		throw response
	}
	c.header('Cache-Control', 'private, no-store')
	await next()
})

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
		.leftJoin(mailboxReadReceipts, readJoin(auth.sub))
		.where(isNull(mailboxReadReceipts.submissionId))
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
		.leftJoin(mailboxReadReceipts, readJoin(auth.sub))
		.where(isNull(mailboxReadReceipts.submissionId))
	const rows = await db
		.select({
			id: websiteFormSubmissions.id,
			formId: websiteFormSubmissions.formId,
			formName: websiteForms.name,
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
		.where(eq(websiteFormSubmissions.id, id))
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
			.where(eq(websiteFormSubmissions.id, c.req.param('submissionId') || ''))
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
