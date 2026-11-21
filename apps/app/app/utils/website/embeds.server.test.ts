import { describe, expect, it } from 'vitest'
import { getDefaultConfig, LOCALIZED_FIELDS } from './block-types.ts'
import { sanitizeEmbedSectionConfig } from './embeds.server.ts'

function sanitize(value: unknown) {
	return sanitizeEmbedSectionConfig(JSON.stringify(value))
}

describe('sanitizeEmbedSectionConfig (#259)', () => {
	it('keeps the provider, its ids and the height, and drops everything else', () => {
		const result = sanitize({
			title: 'Book',
			provider: 'opentable',
			ids: { restaurantId: '12345' },
			height: 400,
			background: 'muted',
			html: '<script>alert(1)</script>',
			src: 'https://evil.example/x',
		})
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(JSON.parse(result.config)).toEqual({
			title: 'Book',
			provider: 'opentable',
			ids: { restaurantId: '12345' },
			height: 400,
			background: 'muted',
		})
		expect(result.config).not.toContain('script')
		expect(result.config).not.toContain('evil')
	})

	it('refuses ids that are an address or markup', () => {
		for (const ids of [
			{ restaurantId: 'https://evil.example' },
			{ restaurantId: '<img src=x onerror=alert(1)>' },
			{ src: 'https://evil.example/x' },
		]) {
			expect(sanitize({ provider: 'opentable', ids }).ok).toBe(false)
		}
	})

	it('refuses a provider that is not on the list', () => {
		expect(sanitize({ provider: 'evil', ids: { x: '1' } }).ok).toBe(false)
		expect(sanitizeEmbedSectionConfig('not json').ok).toBe(false)
	})

	it('keeps a freshly added or half-filled section', () => {
		expect(sanitize(getDefaultConfig('embed')).ok).toBe(true)
		expect(sanitize({ provider: 'resy', ids: {} }).ok).toBe(true)
	})

	it('is a registered block with a translatable title', () => {
		expect(getDefaultConfig('embed')).toMatchObject({ provider: '', ids: {} })
		expect(LOCALIZED_FIELDS.embed).toEqual(['title'])
	})
})
