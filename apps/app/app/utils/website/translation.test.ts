import { describe, expect, it } from 'vitest'
import {
	getDefaultConfig,
	LOCALIZED_FIELDS,
	type BlockType,
} from './block-types.ts'
import {
	collectTranslationFields,
	getNestedValue,
	getTranslatedConfig,
	resolvePaths,
	toTranslateItem,
} from './translation.ts'

describe('collectTranslationFields', () => {
	it('treats matching target copy as untranslated', () => {
		const fields = collectTranslationFields(
			[
				{
					id: 'hero-1',
					type: 'hero',
					config: {
						heading: JSON.stringify({ en: 'Hello', ar: 'Hello' }),
					},
				},
			],
			'en',
			'ar',
		)

		expect(fields).toHaveLength(1)
		expect(fields[0]?.hasCustomTranslation).toBe(false)
		expect(fields[0]?.defaultText).toBe('Hello')
	})

	it('detects custom translations that differ from default', () => {
		const fields = collectTranslationFields(
			[
				{
					id: 'hero-1',
					type: 'hero',
					config: {
						heading: JSON.stringify({ en: 'Hello', ar: 'مرحبا' }),
					},
				},
			],
			'en',
			'ar',
		)

		expect(fields[0]?.hasCustomTranslation).toBe(true)
	})

	it('marks only content body fields as HTML-safe', () => {
		const fields = collectTranslationFields(
			[
				{
					id: 'content-1',
					type: 'content',
					config: {
						title: JSON.stringify({ en: 'Title' }),
						body: JSON.stringify({ en: '<p>Body</p>' }),
					},
				},
			],
			'en',
			'ar',
		)

		const title = fields.find((field) => field.path === 'title')
		const body = fields.find((field) => field.path === 'body')
		expect(title?.allowHtml).toBe(false)
		expect(body?.allowHtml).toBe(true)
	})

	it('resolves nested array fields from real block defaults', () => {
		for (const type of Object.keys(LOCALIZED_FIELDS)) {
			const config = getDefaultConfig(type as BlockType)
			if (type === 'header') {
				config.navLinks = [{ label: 'Home' }]
			}
			if (type === 'hero') {
				config.slides = [{ url: '', alt: 'Welcome' }]
			}
			for (const pathDef of LOCALIZED_FIELDS[type] ?? []) {
				expect(resolvePaths(config, pathDef)).not.toHaveLength(0)
			}
		}
	})

	it('does not emit leaf paths for string-array items', () => {
		expect(
			resolvePaths({ labels: ['hello', 'world'] }, 'labels.[].value'),
		).toEqual([])
	})

	it('resolves nested object-array leaf paths', () => {
		expect(
			resolvePaths(
				{ links: [{ link: { label: 'Home' } }, { link: { label: 'About' } }] },
				'links.[].link.label',
			),
		).toEqual(['links.[0].link.label', 'links.[1].link.label'])
	})
})

describe('toTranslateItem', () => {
	it('returns null when the default locale is empty', () => {
		expect(
			toTranslateItem('content', { en: '', ar: 'مرحبا' }, 'en', 'ar'),
		).toBeNull()
	})

	it('treats matching target copy as untranslated', () => {
		expect(
			toTranslateItem(
				'content',
				JSON.stringify({ en: 'Hello', ar: 'Hello' }),
				'en',
				'ar',
			),
		).toEqual({
			id: 'content',
			defaultText: 'Hello',
			existingTarget: 'Hello',
			hasCustomTranslation: false,
			allowHtml: false,
		})
	})
})

describe('getTranslatedConfig', () => {
	it('writes translated values to allowed localized paths', () => {
		const config = { heading: JSON.stringify({ en: 'Hello' }) }
		const next = getTranslatedConfig(
			config,
			'hero',
			{ heading: 'مرحبا' },
			'ar',
			'en',
		)
		expect(getNestedValue(next, 'heading')).toBe(
			JSON.stringify({ en: 'Hello', ar: 'مرحبا' }),
		)
	})

	it('ignores paths outside the block localized field set', () => {
		const config = {
			heading: JSON.stringify({ en: 'Hello' }),
			imageUrl: '/untranslated.png',
		}
		const next = getTranslatedConfig(
			config,
			'hero',
			{ imageUrl: 'https://evil.example' },
			'ar',
			'en',
		)
		expect(getNestedValue(next, 'imageUrl')).toBe('/untranslated.png')
	})

	it('returns a clone unchanged for unknown block types', () => {
		const config = { arbitrary: 'value' }
		const next = getTranslatedConfig(
			config,
			'not-a-block',
			{ arbitrary: 'changed' },
			'ar',
			'en',
		)
		expect(next).toEqual(config)
		expect(next).not.toBe(config)
	})
})
