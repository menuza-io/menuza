import { describe, expect, it } from 'vitest'

import {
	buildEmailTemplateBlocks,
	createEmailBlockId,
	EMAIL_BLOCK_TEMPLATES,
	emailBlocksSchema,
	getDefaultEmailBlock,
	parseEmailBlocks,
	serializeEmailBlocks,
} from './email-blocks'

describe('email blocks schema', () => {
	it('parses a valid block list and fills defaults', () => {
		const blocks = parseEmailBlocks(
			JSON.stringify([
				{ id: 'block-1', type: 'heading', config: { text: 'Hi' } },
				{
					id: 'block-2',
					type: 'button',
					config: { label: 'Go', url: 'https://example.com' },
				},
			]),
		)

		expect(blocks).toHaveLength(2)
		expect(blocks[0]).toMatchObject({
			type: 'heading',
			config: { text: 'Hi', level: 'h2', align: 'left' },
		})
		expect(blocks[1]).toMatchObject({
			type: 'button',
			config: { variant: 'primary', align: 'left' },
		})
	})

	it('returns an empty list for malformed or missing input', () => {
		expect(parseEmailBlocks('not json')).toEqual([])
		expect(parseEmailBlocks(null)).toEqual([])
		expect(parseEmailBlocks('')).toEqual([])
	})

	it('defaults button width to auto and accepts full', () => {
		const blocks = parseEmailBlocks(
			JSON.stringify([
				{
					id: 'block-1',
					type: 'button',
					config: { label: 'Go', url: 'https://example.com' },
				},
				{
					id: 'block-2',
					type: 'button',
					config: { label: 'Wide', url: '', width: 'full' },
				},
			]),
		)

		expect(blocks[0]).toMatchObject({ config: { width: 'auto' } })
		expect(blocks[1]).toMatchObject({ config: { width: 'full' } })
	})

	it('rejects an unknown button width', () => {
		const result = emailBlocksSchema.safeParse([
			{
				id: 'block-1',
				type: 'button',
				config: { label: 'Go', url: '', width: 'half' },
			},
		])
		expect(result.success).toBe(false)
	})

	it('rejects duplicate block ids', () => {
		const result = emailBlocksSchema.safeParse([
			{ id: 'block-1', type: 'body', config: { text: 'a' } },
			{ id: 'block-1', type: 'body', config: { text: 'b' } },
		])
		expect(result.success).toBe(false)
	})

	it('rejects an unknown block type', () => {
		const result = emailBlocksSchema.safeParse([
			{ id: 'block-1', type: 'video', config: {} },
		])
		expect(result.success).toBe(false)
	})

	it('round-trips through serialize/parse', () => {
		const blocks = [
			getDefaultEmailBlock('heading'),
			getDefaultEmailBlock('image'),
		]
		expect(parseEmailBlocks(serializeEmailBlocks(blocks))).toEqual(blocks)
	})

	it('generates unique, schema-valid ids', () => {
		const ids = new Set(Array.from({ length: 50 }, () => createEmailBlockId()))
		expect(ids.size).toBe(50)
		for (const id of ids) {
			expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
		}
	})

	it('builds template blocks with fresh ids', () => {
		for (const template of EMAIL_BLOCK_TEMPLATES) {
			const blocks = buildEmailTemplateBlocks(template.id)
			expect(blocks).toHaveLength(template.blocks.length)
			expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length)
			expect(emailBlocksSchema.safeParse(blocks).success).toBe(true)
		}
	})
})
