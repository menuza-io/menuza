import { db, eq, Organization, OrganizationMenuItem } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type * as reservationsAccess from '#app/utils/reservations/access.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => true),
}))
vi.mock('#app/utils/reservations/access.server.ts', async (importOriginal) => ({
	...(await importOriginal<typeof reservationsAccess>()),
	notifyReservationsContextChanged: vi.fn(async () => undefined),
}))

import { action } from './_index.tsx'

type Setup = Awaited<ReturnType<typeof setupTestOrgWithUser>>

async function saveLocales(
	setup: Setup,
	locales: string[],
	defaultLocale = 'en',
) {
	const form = new FormData()
	form.set('intent', 'update-site-locales')
	form.set('organizationId', setup.organization.id)
	for (const locale of locales) form.append('locales', locale)
	form.set('defaultLocale', defaultLocale)
	const request = new Request(
		`https://app.example/${setup.organization.slug}/website`,
		{ method: 'POST', body: form, headers: { cookie: setup.cookie } },
	)
	try {
		return (await action({
			request,
			params: { orgSlug: setup.organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

async function storedLocales(organizationId: string) {
	const [row] = await db
		.select({ siteLocales: Organization.siteLocales })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
	return row?.siteLocales
}

describe('removing a website language (#410)', () => {
	it('is refused while a menu name would be left empty', async () => {
		const setup = await setupTestOrgWithUser()
		await db
			.update(Organization)
			.set({ siteLocales: '["en","ar"]', siteDefaultLocale: 'en' })
			.where(eq(Organization.id, setup.organization.id))
		const [dish] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: setup.organization.id,
				displayName: JSON.stringify({ ar: 'شاورما' }),
				price: 8,
			})
			.returning()

		const refused = await saveLocales(setup, ['en'])
		const body = (await refused.json()) as {
			result: { error?: Record<string, string[]> }
			blankNames: { count: number; examples: string[] }
		}
		expect(body.result.error?.locales).toEqual(['menu_names_left_blank'])
		expect(body.blankNames).toEqual({ count: 1, examples: ['شاورما'] })
		expect(await storedLocales(setup.organization.id)).toBe('["en","ar"]')

		// Once the dish has an English name too, Arabic can go.
		await db
			.update(OrganizationMenuItem)
			.set({ displayName: JSON.stringify({ en: 'Shawarma', ar: 'شاورما' }) })
			.where(eq(OrganizationMenuItem.id, dish!.id))
		const saved = await saveLocales(setup, ['en'])
		expect(saved.status).toBe(302)
		expect(await storedLocales(setup.organization.id)).toBe('["en"]')
	})
})
