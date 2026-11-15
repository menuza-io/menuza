import {
	createEmailBlockId,
	emailBlocksSchema,
	type EmailBlock,
} from '@repo/common/email-blocks'
import {
	and,
	count,
	db,
	desc,
	eq,
	MarketingEmailTemplate,
	sql,
} from '@repo/database'
import { refreshMenuItemBlocks } from '#app/utils/email/menu-items.server.ts'

/**
 * A restaurant's own saved email layouts (#154). Control plane only: a template
 * is a name and the designer's blocks, never an audience, coupon or schedule,
 * and it holds no guest data. Starting from a template copies it (fresh block
 * ids, dishes re-read from the live menu), so editing a template later never
 * changes a message already saved or sent.
 */

export const EMAIL_TEMPLATE_LIMIT = 100
export const EMAIL_TEMPLATE_NAME_MAX = 80

export type EmailTemplateError =
	| 'template_limit_reached'
	| 'template_name_taken'
	| 'template_not_found'
	| 'invalid_name'
	| 'invalid_blocks'

export type EmailTemplate = {
	id: string
	name: string
	blocks: EmailBlock[]
	updatedAt: string
}

export type EmailTemplateResult<T> =
	{ ok: true; value: T } | { ok: false; error: EmailTemplateError }

const fail = (error: EmailTemplateError) => ({ ok: false as const, error })

function cleanName(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const name = value.replace(/\s+/g, ' ').trim()
	return name.length > 0 && name.length <= EMAIL_TEMPLATE_NAME_MAX ? name : null
}

/** Stored or posted blocks, strictly: a template never keeps a malformed block. */
export function parseTemplateBlocks(value: unknown): EmailBlock[] | null {
	let raw = value
	if (typeof value === 'string') {
		try {
			raw = JSON.parse(value)
		} catch {
			return null
		}
	}
	const parsed = emailBlocksSchema.safeParse(raw)
	return parsed.success && parsed.data.length > 0 ? parsed.data : null
}

function toTemplate(row: {
	id: string
	name: string
	blocks: string
	updatedAt: Date
}): EmailTemplate | null {
	const blocks = parseTemplateBlocks(row.blocks)
	return blocks
		? {
				id: row.id,
				name: row.name,
				blocks,
				updatedAt: row.updatedAt.toISOString(),
			}
		: null
}

function isUniqueNameError(error: unknown) {
	const text = `${(error as Error)?.message ?? ''} ${(error as { cause?: Error })?.cause?.message ?? ''}`
	return /UNIQUE constraint failed/i.test(text)
}

async function nameTaken(
	organizationId: string,
	name: string,
	exceptId?: string,
) {
	const rows = await db
		.select({ id: MarketingEmailTemplate.id })
		.from(MarketingEmailTemplate)
		.where(
			and(
				eq(MarketingEmailTemplate.organizationId, organizationId),
				sql`lower(${MarketingEmailTemplate.name}) = lower(${name})`,
			),
		)
	return rows.some((row) => row.id !== exceptId)
}

export async function listEmailTemplates(
	organizationId: string,
): Promise<EmailTemplate[]> {
	const rows = await db
		.select()
		.from(MarketingEmailTemplate)
		.where(eq(MarketingEmailTemplate.organizationId, organizationId))
		.orderBy(desc(MarketingEmailTemplate.updatedAt))
		.limit(EMAIL_TEMPLATE_LIMIT)
	return rows.flatMap((row) => {
		const template = toTemplate(row)
		return template ? [template] : []
	})
}

export async function createEmailTemplate(input: {
	organizationId: string
	userId: string
	name: unknown
	blocks: unknown
}): Promise<EmailTemplateResult<EmailTemplate>> {
	const name = cleanName(input.name)
	if (!name) return fail('invalid_name')
	const blocks = parseTemplateBlocks(input.blocks)
	if (!blocks) return fail('invalid_blocks')

	const [{ total } = { total: 0 }] = await db
		.select({ total: count() })
		.from(MarketingEmailTemplate)
		.where(eq(MarketingEmailTemplate.organizationId, input.organizationId))
	if (total >= EMAIL_TEMPLATE_LIMIT) return fail('template_limit_reached')
	if (await nameTaken(input.organizationId, name)) {
		return fail('template_name_taken')
	}

	try {
		const [row] = await db
			.insert(MarketingEmailTemplate)
			.values({
				organizationId: input.organizationId,
				name,
				blocks: JSON.stringify(blocks),
				createdById: input.userId,
			})
			.returning()
		const template = row ? toTemplate(row) : null
		return template ? { ok: true, value: template } : fail('invalid_blocks')
	} catch (error) {
		if (isUniqueNameError(error)) return fail('template_name_taken')
		throw error
	}
}

export async function renameEmailTemplate(input: {
	organizationId: string
	id: string
	name: unknown
}): Promise<EmailTemplateResult<EmailTemplate>> {
	const name = cleanName(input.name)
	if (!name) return fail('invalid_name')
	if (await nameTaken(input.organizationId, name, input.id)) {
		return fail('template_name_taken')
	}
	try {
		const [row] = await db
			.update(MarketingEmailTemplate)
			.set({ name })
			.where(
				and(
					eq(MarketingEmailTemplate.id, input.id),
					eq(MarketingEmailTemplate.organizationId, input.organizationId),
				),
			)
			.returning()
		const template = row ? toTemplate(row) : null
		return template ? { ok: true, value: template } : fail('template_not_found')
	} catch (error) {
		if (isUniqueNameError(error)) return fail('template_name_taken')
		throw error
	}
}

export async function duplicateEmailTemplate(input: {
	organizationId: string
	userId: string
	id: string
}): Promise<EmailTemplateResult<EmailTemplate>> {
	const [source] = await db
		.select()
		.from(MarketingEmailTemplate)
		.where(
			and(
				eq(MarketingEmailTemplate.id, input.id),
				eq(MarketingEmailTemplate.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!source) return fail('template_not_found')
	const blocks = parseTemplateBlocks(source.blocks)
	if (!blocks) return fail('invalid_blocks')

	// "Name (copy)", then "Name (copy 2)", … within the name limit.
	for (let attempt = 1; attempt <= 20; attempt++) {
		const suffix = attempt === 1 ? ' (copy)' : ` (copy ${attempt})`
		const name = `${source.name.slice(0, EMAIL_TEMPLATE_NAME_MAX - suffix.length)}${suffix}`
		const created = await createEmailTemplate({
			organizationId: input.organizationId,
			userId: input.userId,
			name,
			blocks,
		})
		if (created.ok || created.error !== 'template_name_taken') return created
	}
	return fail('template_name_taken')
}

export async function deleteEmailTemplate(input: {
	organizationId: string
	id: string
}): Promise<EmailTemplateResult<true>> {
	const rows = await db
		.delete(MarketingEmailTemplate)
		.where(
			and(
				eq(MarketingEmailTemplate.id, input.id),
				eq(MarketingEmailTemplate.organizationId, input.organizationId),
			),
		)
		.returning({ id: MarketingEmailTemplate.id })
	return rows.length > 0
		? { ok: true, value: true }
		: fail('template_not_found')
}

/** The blocks of a template as a new message's starting point: a copy. */
export async function startFromEmailTemplate(input: {
	organizationId: string
	id: string
	baseUrl: string
}): Promise<EmailTemplateResult<EmailBlock[]>> {
	const [row] = await db
		.select()
		.from(MarketingEmailTemplate)
		.where(
			and(
				eq(MarketingEmailTemplate.id, input.id),
				eq(MarketingEmailTemplate.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!row) return fail('template_not_found')
	const blocks = parseTemplateBlocks(row.blocks)
	if (!blocks) return fail('invalid_blocks')
	const fresh = blocks.map((block) => ({ ...block, id: createEmailBlockId() }))
	return {
		ok: true,
		value: await refreshMenuItemBlocks(
			input.organizationId,
			fresh as EmailBlock[],
			input.baseUrl,
		),
	}
}
