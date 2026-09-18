import { auditService, AuditAction } from '@repo/audit'
import type * as DatabaseModule from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	HOME_PAGE_SLUG,
	HOME_PAGE_TITLE,
} from '#app/utils/website/home-page.ts'
import {
	captureInserts,
	mockDb,
	mockSelectResults,
	resetMockDb,
} from '#tests/setup/drizzle-mock.ts'
import { createOrganization } from './organizations.server.ts'

type CreatedHomePageSection = {
	type: string
	position: number
	config: string
}

vi.mock('#app/utils/organization/locations.server.ts', () => ({
	ensureDefaultOrganizationLocation: vi.fn().mockResolvedValue('loc-default'),
}))

vi.mock('@repo/audit', () => ({
	AuditAction: {
		ORG_CREATED: 'ORG_CREATED',
	},
	auditService: {
		log: vi.fn(),
	},
}))

vi.mock('@repo/auth', () => ({
	getUserId: vi.fn(),
}))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	const { mockDb, drizzleTable, drizzleOperator } =
		await import('#tests/setup/drizzle-mock.ts')
	return {
		...actual,
		db: mockDb,
		Organization: drizzleTable,
		OrganizationImage: drizzleTable,
		OrganizationRole: drizzleTable,
		UserOrganization: drizzleTable,
		WebsitePage: drizzleTable,
		WebsitePageSection: drizzleTable,
		and: drizzleOperator,
		count: drizzleOperator,
		desc: drizzleOperator,
		eq: drizzleOperator,
	}
})

describe('createOrganization', () => {
	beforeEach(() => {
		resetMockDb()
		mockSelectResults([{ id: 'role-admin' }])
		vi.mocked(auditService.log).mockResolvedValue(undefined as any)
	})

	it('creates a published protected home page for new organizations', async () => {
		const { insertedValues } = captureInserts(
			[{ id: 'org-1', name: 'Acme', slug: 'acme' }],
			[],
			[{ id: 'page-1' }],
			[],
		)

		await createOrganization({
			name: 'Acme',
			slug: 'acme',
			description: 'Custom storefronts',
			userId: 'user-1',
		})

		const organizationValues = insertedValues[0] as {
			siteHeaderConfig: string
			siteFooterConfig: string
		}
		expect(JSON.parse(organizationValues.siteHeaderConfig)).toEqual(
			expect.objectContaining({
				navLinks: [],
				ctaLabel: 'Get started',
				ctaUrl: '/login',
			}),
		)
		expect(JSON.parse(organizationValues.siteFooterConfig)).toEqual(
			expect.objectContaining({
				columns: [
					{
						title: 'Explore',
						links: [{ label: 'Home', url: '/' }],
					},
				],
				ctaLabel: 'Get started',
				ctaUrl: '/login',
			}),
		)

		const pageValues = insertedValues[2] as {
			organizationId: string
			title: string
			slug: string
			status: string
			template: string
			isHomePage: boolean
			position: number
			createdById: string
		}
		expect(pageValues).toEqual(
			expect.objectContaining({
				organizationId: 'org-1',
				title: HOME_PAGE_TITLE,
				slug: HOME_PAGE_SLUG,
				status: 'published',
				template: 'blank',
				isHomePage: true,
				position: 0,
				createdById: 'user-1',
			}),
		)

		const sections = insertedValues[3] as CreatedHomePageSection[]
		expect(sections.map((section) => section.type)).toEqual([
			'hero',
			'features',
			'content',
			'cards',
			'testimonials',
			'faq',
			'cta',
		])

		const heroSection = sections[0]!
		expect(heroSection).toEqual(
			expect.objectContaining({
				type: 'hero',
				position: 0,
			}),
		)
		expect(JSON.parse(heroSection.config)).toEqual(
			expect.objectContaining({
				heading: 'Welcome to Acme',
				subheading:
					'Custom storefronts. Discover a better way to connect, decide, and get started with Acme.',
			}),
		)

		const ctaSection = sections[6]!
		expect(JSON.parse(ctaSection.config)).toEqual(
			expect.objectContaining({
				heading: 'Ready to experience Acme?',
				primaryLabel: 'Get started',
				primaryUrl: '/login',
			}),
		)
	})

	it('does not create an organization without the admin role', async () => {
		resetMockDb()
		mockSelectResults([])

		await expect(
			createOrganization({
				name: 'Acme',
				slug: 'acme',
				userId: 'user-1',
			}),
		).rejects.toThrow('Admin role not found')

		expect(mockDb.insert).not.toHaveBeenCalled()
		expect(auditService.log).not.toHaveBeenCalledWith(
			expect.objectContaining({ action: AuditAction.ORG_CREATED }),
		)
	})
})
