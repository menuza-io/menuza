import { describe, expect, it } from 'vitest'
import {
	ADDABLE_BLOCK_TYPES,
	composePageSectionsWithChrome,
	extraLockedChromeIds,
	isLockedBlockType,
	isSiteChromeId,
	PAGE_TEMPLATES,
	pinLockedChromeOrder,
	SITE_FOOTER_ID,
	SITE_HEADER_ID,
} from './block-types.ts'

describe('website block types', () => {
	it('locks header and footer', () => {
		expect(isLockedBlockType('header')).toBe(true)
		expect(isLockedBlockType('footer')).toBe(true)
		expect(isLockedBlockType('hero')).toBe(false)
	})

	it('keeps header and footer out of the addable list', () => {
		expect(
			ADDABLE_BLOCK_TYPES.every((block) => !isLockedBlockType(block.type)),
		).toBe(true)
		expect(
			ADDABLE_BLOCK_TYPES.some((block) => block.type === 'testimonials'),
		).toBe(true)
		expect(ADDABLE_BLOCK_TYPES.some((block) => block.type === 'form')).toBe(
			true,
		)
	})

	it('pins header first and footer last when reordering', () => {
		const typesById = new Map([
			['h', 'header'],
			['a', 'hero'],
			['b', 'faq'],
			['f', 'footer'],
		])
		expect(pinLockedChromeOrder(['a', 'h', 'f', 'b'], typesById)).toEqual([
			'h',
			'a',
			'b',
			'f',
		])
	})

	it('keeps a single header and footer when duplicates are present', () => {
		const typesById = new Map([
			['h1', 'header'],
			['h2', 'header'],
			['a', 'hero'],
			['f1', 'footer'],
			['f2', 'footer'],
		])
		expect(
			pinLockedChromeOrder(['h1', 'h2', 'a', 'f1', 'f2'], typesById),
		).toEqual(['h1', 'a', 'f1'])
	})

	it('identifies extra locked chrome after the first of each type', () => {
		expect(
			extraLockedChromeIds([
				{ id: 'h1', type: 'header' },
				{ id: 'h2', type: 'header' },
				{ id: 'hero', type: 'hero' },
				{ id: 'f1', type: 'footer' },
				{ id: 'f2', type: 'footer' },
			]),
		).toEqual(['h2', 'f2'])
	})

	it('does not store header or footer on page templates', () => {
		for (const template of Object.values(PAGE_TEMPLATES)) {
			expect(
				template.sections.every((section) => !isLockedBlockType(section.type)),
			).toBe(true)
		}
		expect(PAGE_TEMPLATES.blank.sections).toEqual([])
		expect(
			PAGE_TEMPLATES.article.sections.map((section) => section.type),
		).toEqual(['hero', 'content'])
	})

	it('identifies site chrome ids', () => {
		expect(isSiteChromeId(SITE_HEADER_ID)).toBe(true)
		expect(isSiteChromeId(SITE_FOOTER_ID)).toBe(true)
		expect(isSiteChromeId('clxyz')).toBe(false)
	})

	it('wraps page body sections with shared header and footer', () => {
		expect(
			composePageSectionsWithChrome(
				[
					{
						id: 'hero',
						type: 'hero',
						config: '{}',
						position: 4,
					},
				],
				'{"sticky":true}',
				'{"showCta":true}',
			),
		).toEqual([
			{
				id: SITE_HEADER_ID,
				type: 'header',
				config: '{"sticky":true}',
				position: 0,
			},
			{ id: 'hero', type: 'hero', config: '{}', position: 1 },
			{
				id: SITE_FOOTER_ID,
				type: 'footer',
				config: '{"showCta":true}',
				position: 2,
			},
		])
	})
})
