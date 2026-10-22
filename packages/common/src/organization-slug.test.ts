import { describe, expect, it } from 'vitest'
import { organizationSlugSchema } from './organization-slug.js'

describe('organizationSlugSchema', () => {
	it('accepts lowercase slugs with hyphens', () => {
		expect(organizationSlugSchema.safeParse('acme-corp').success).toBe(true)
	})

	it('rejects spaces and symbols', () => {
		expect(organizationSlugSchema.safeParse('Bad Slug!').success).toBe(false)
	})

	it('reserves pos for the till without rejecting restaurant names containing it', () => {
		expect(organizationSlugSchema.safeParse('pos').success).toBe(false)
		expect(organizationSlugSchema.safeParse('pos-cafe').success).toBe(true)
	})
})
