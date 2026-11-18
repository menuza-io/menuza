import {
	db,
	eq,
	Organization,
	OrganizationMenuItem,
	OrganizationMenuOption,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { loader } from './translations.tsx'

type Setup = Awaited<ReturnType<typeof setupTestOrgWithUser>>

async function load(setup: Setup, query = '') {
	const request = new Request(
		`https://app.example/${setup.organization.slug}/menu/translations${query}`,
		{ headers: { cookie: setup.cookie } },
	)
	return loader({
		request,
		params: { orgSlug: setup.organization.slug },
		context: new RouterContextProvider(),
	} as never)
}

describe('Menu translations (#410)', () => {
	it('lists a dish with no Arabic name and updates after saving', async () => {
		const setup = await setupTestOrgWithUser()
		await db
			.update(Organization)
			.set({ siteLocales: '["en","ar"]', siteDefaultLocale: 'en' })
			.where(eq(Organization.id, setup.organization.id))
		const [dish] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: setup.organization.id,
				displayName: JSON.stringify({ en: 'Shawarma' }),
				description: JSON.stringify({ en: 'Wrap', ar: 'لفافة' }),
				price: 8,
			})
			.returning()
		await db.insert(OrganizationMenuOption).values({
			organizationId: setup.organization.id,
			displayName: JSON.stringify({ en: 'Garlic', ar: 'ثوم' }),
			description: JSON.stringify({ en: 'Strong' }),
		})

		const first = await load(setup)
		expect(first.filter.locale).toBe('ar')
		expect(first.gaps).toEqual([
			{
				kind: 'item',
				id: dish!.id,
				field: 'name',
				locale: 'ar',
				label: 'Shawarma',
			},
			expect.objectContaining({
				kind: 'option',
				field: 'description',
				locale: 'ar',
				label: 'Garlic',
			}),
		])
		const ar = first.summaries.find((summary) => summary.locale === 'ar')
		expect(ar).toMatchObject({ missingNames: 1, missingDescriptions: 1 })

		// Names only.
		const namesOnly = await load(setup, '?field=name')
		expect(namesOnly.gaps.map((gap) => gap.id)).toEqual([dish!.id])

		// The owner saves the Arabic name; the list no longer shows the dish.
		await db
			.update(OrganizationMenuItem)
			.set({ displayName: JSON.stringify({ en: 'Shawarma', ar: 'شاورما' }) })
			.where(eq(OrganizationMenuItem.id, dish!.id))
		const after = await load(setup, '?field=name')
		expect(after.gaps).toEqual([])
	})

	it('needs menu read access', async () => {
		const setup = await setupTestOrgWithUser('guest')
		await expect(load(setup)).rejects.toMatchObject({ status: 403 })
	})
})
