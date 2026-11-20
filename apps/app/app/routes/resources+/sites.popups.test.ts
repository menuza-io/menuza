import { db, eq, Organization, SitePopup } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { loader } from './sites.popups.ts'

const flags = vi.hoisted(() => ({ values: {} as Record<string, unknown> }))
vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: async (key: string) => flags.values[key] ?? null,
}))

function call(query: string) {
	return loader({
		request: new Request(
			`http://localhost:3001/resources/sites/popups?${query}`,
		),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: '/resources/sites/popups',
	} as never)
}

async function publishedOrg() {
	const { organization } = await setupTestOrgWithUser('admin')
	await db
		.update(Organization)
		.set({ sitePublished: true })
		.where(eq(Organization.id, organization.id))
	await db.insert(SitePopup).values({
		organizationId: organization.id,
		name: 'Welcome',
		status: 'published',
		title: JSON.stringify({ en: 'Hello', ar: 'مرحبا' }),
		body: JSON.stringify({ en: 'Body' }),
		buttonLabel: JSON.stringify({ en: 'Go' }),
		buttonUrl: '/menu',
	})
	await db.insert(SitePopup).values({
		organizationId: organization.id,
		name: 'Draft',
		status: 'draft',
		title: 'Hidden',
	})
	return organization
}

describe('GET /resources/sites/popups', () => {
	beforeEach(() => {
		flags.values = { 'website.popups': true }
	})

	it('serves the published popups, localized, never cached', async () => {
		const org = await publishedOrg()
		const response = await call(`slug=${org.slug}`)
		expect(response.headers.get('cache-control')).toBe('private, no-store')
		const body = (await response.json()) as {
			popups: Array<Record<string, unknown>>
		}
		expect(body.popups).toHaveLength(1)
		expect(body.popups[0]).toMatchObject({
			title: 'Hello',
			buttonUrl: '/menu',
			couponCode: null,
		})
	})

	it('serves nothing while the flag is off', async () => {
		const org = await publishedOrg()
		flags.values = {}
		const body = (await (await call(`slug=${org.slug}`)).json()) as {
			popups: unknown[]
		}
		expect(body.popups).toEqual([])
	})

	it('404s for an unknown or unpublished site', async () => {
		await expect(call('slug=nobody-here')).rejects.toMatchObject({
			status: 404,
		})
		const { organization } = await setupTestOrgWithUser('admin')
		await expect(call(`slug=${organization.slug}`)).rejects.toMatchObject({
			status: 404,
		})
	})
})
