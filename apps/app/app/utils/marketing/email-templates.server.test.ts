import { getDefaultEmailBlock } from '@repo/common/email-blocks'
import { db, eq, MarketingEmailTemplate } from '@repo/database'
import { describe, expect, it } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import {
	createEmailTemplate,
	deleteEmailTemplate,
	duplicateEmailTemplate,
	EMAIL_TEMPLATE_LIMIT,
	listEmailTemplates,
	parseTemplateBlocks,
	renameEmailTemplate,
	startFromEmailTemplate,
} from './email-templates.server.ts'

const blocks = () => [
	getDefaultEmailBlock('heading'),
	getDefaultEmailBlock('button'),
]

async function setup() {
	const { organization, user } = await setupTestOrgWithUser()
	return { organizationId: organization.id, userId: user.id }
}

describe('saved email templates', () => {
	it('saves and lists a template: blocks only, validated strictly', async () => {
		const { organizationId, userId } = await setup()
		const created = await createEmailTemplate({
			organizationId,
			userId,
			name: '  Weekly   newsletter ',
			blocks: JSON.stringify(blocks()),
		})
		expect(created.ok).toBe(true)
		const listed = await listEmailTemplates(organizationId)
		expect(listed).toHaveLength(1)
		expect(listed[0]?.name).toBe('Weekly newsletter')
		expect(listed[0]?.blocks).toHaveLength(2)

		// No audience, coupon or schedule can ride along.
		const [row] = await db
			.select()
			.from(MarketingEmailTemplate)
			.where(eq(MarketingEmailTemplate.organizationId, organizationId))
		expect(Object.keys(row!).sort()).toEqual([
			'blocks',
			'createdAt',
			'createdById',
			'id',
			'name',
			'organizationId',
			'updatedAt',
		])
	})

	it('refuses an empty name, a long name, malformed blocks and no blocks', async () => {
		const { organizationId, userId } = await setup()
		const base = { organizationId, userId, blocks: JSON.stringify(blocks()) }
		expect(await createEmailTemplate({ ...base, name: '   ' })).toEqual({
			ok: false,
			error: 'invalid_name',
		})
		expect(
			await createEmailTemplate({ ...base, name: 'x'.repeat(81) }),
		).toEqual({
			ok: false,
			error: 'invalid_name',
		})
		expect(
			await createEmailTemplate({
				...base,
				name: 'Bad',
				blocks: JSON.stringify([{ id: 'a', type: 'nope', config: {} }]),
			}),
		).toEqual({ ok: false, error: 'invalid_blocks' })
		expect(
			await createEmailTemplate({ ...base, name: 'Empty', blocks: '[]' }),
		).toEqual({ ok: false, error: 'invalid_blocks' })
		expect(parseTemplateBlocks('not json')).toBeNull()
	})

	it('keeps names unique per organization, ignoring case', async () => {
		const a = await setup()
		const b = await setup()
		const input = { blocks: JSON.stringify(blocks()) }
		expect(
			(await createEmailTemplate({ ...a, ...input, name: 'Lunch' })).ok,
		).toBe(true)
		expect(
			await createEmailTemplate({ ...a, ...input, name: 'lunch' }),
		).toEqual({ ok: false, error: 'template_name_taken' })
		// Another organization may use the same name.
		expect(
			(await createEmailTemplate({ ...b, ...input, name: 'Lunch' })).ok,
		).toBe(true)
	})

	it('stops at 100 templates per organization', async () => {
		const { organizationId, userId } = await setup()
		await db.insert(MarketingEmailTemplate).values(
			Array.from({ length: EMAIL_TEMPLATE_LIMIT }, (_, i) => ({
				organizationId,
				name: `T${i}`,
				blocks: JSON.stringify(blocks()),
			})),
		)
		expect(
			await createEmailTemplate({
				organizationId,
				userId,
				name: 'One too many',
				blocks: JSON.stringify(blocks()),
			}),
		).toEqual({ ok: false, error: 'template_limit_reached' })
	})

	it('renames, refuses a taken name and a template of another organization', async () => {
		const a = await setup()
		const b = await setup()
		const one = await createEmailTemplate({
			...a,
			name: 'One',
			blocks: JSON.stringify(blocks()),
		})
		await createEmailTemplate({
			...a,
			name: 'Two',
			blocks: JSON.stringify(blocks()),
		})
		if (!one.ok) throw new Error('setup')
		expect(
			await renameEmailTemplate({
				organizationId: a.organizationId,
				id: one.value.id,
				name: 'Two',
			}),
		).toEqual({ ok: false, error: 'template_name_taken' })
		// Renaming to its own name in another case is allowed.
		expect(
			(
				await renameEmailTemplate({
					organizationId: a.organizationId,
					id: one.value.id,
					name: 'ONE',
				})
			).ok,
		).toBe(true)
		expect(
			await renameEmailTemplate({
				organizationId: b.organizationId,
				id: one.value.id,
				name: 'Mine now',
			}),
		).toEqual({ ok: false, error: 'template_not_found' })
		expect(
			await deleteEmailTemplate({
				organizationId: b.organizationId,
				id: one.value.id,
			}),
		).toEqual({ ok: false, error: 'template_not_found' })
	})

	it('duplicates with a free name and deletes', async () => {
		const a = await setup()
		const one = await createEmailTemplate({
			...a,
			name: 'Newsletter',
			blocks: JSON.stringify(blocks()),
		})
		if (!one.ok) throw new Error('setup')
		const first = await duplicateEmailTemplate({ ...a, id: one.value.id })
		const second = await duplicateEmailTemplate({ ...a, id: one.value.id })
		expect(first.ok && first.value.name).toBe('Newsletter (copy)')
		expect(second.ok && second.value.name).toBe('Newsletter (copy 2)')
		expect(
			await deleteEmailTemplate({
				organizationId: a.organizationId,
				id: one.value.id,
			}),
		).toEqual({ ok: true, value: true })
		expect(await listEmailTemplates(a.organizationId)).toHaveLength(2)
	})

	it('starting from a template is a copy: fresh ids, later edits change nothing', async () => {
		const a = await setup()
		const saved = await createEmailTemplate({
			...a,
			name: 'Base',
			blocks: JSON.stringify(blocks()),
		})
		if (!saved.ok) throw new Error('setup')
		const started = await startFromEmailTemplate({
			organizationId: a.organizationId,
			id: saved.value.id,
			baseUrl: 'https://app.test',
		})
		if (!started.ok) throw new Error('start failed')
		const startedIds = started.value.map((block) => block.id)
		expect(startedIds).not.toEqual(saved.value.blocks.map((block) => block.id))

		// Editing the template afterwards does not touch the copy in hand.
		const [heading] = started.value
		await db
			.update(MarketingEmailTemplate)
			.set({ blocks: JSON.stringify([getDefaultEmailBlock('body')]) })
			.where(eq(MarketingEmailTemplate.id, saved.value.id))
		expect(started.value.map((block) => block.id)).toEqual(startedIds)
		expect(heading?.type).toBe('heading')

		expect(
			await startFromEmailTemplate({
				organizationId: (await setup()).organizationId,
				id: saved.value.id,
				baseUrl: 'https://app.test',
			}),
		).toEqual({ ok: false, error: 'template_not_found' })
	})
})
