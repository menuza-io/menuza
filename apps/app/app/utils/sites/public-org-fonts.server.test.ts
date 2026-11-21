import {
	and,
	db,
	eq,
	FontLicenceAcceptance,
	Organization,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type * as storageModule from '#app/utils/storage.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import {
	findPublishedSiteOrganization,
	toPublicSitePayload,
} from './public-org.server.ts'

vi.mock('#app/utils/storage.server.ts', async (importOriginal) => ({
	...(await importOriginal<typeof storageModule>()),
	getSignedGetRequestInfoAsync: vi.fn(async () => ({
		url: 'https://storage.test/font',
		headers: {},
	})),
}))

async function setup() {
	const { user, organization } = await setupTestOrgWithUser('admin')
	const objectKey = `org/${organization.id}/site-fonts/heading/a1b2c3d4e5f6.woff2`
	await db
		.update(Organization)
		.set({
			sitePublished: true,
			siteTheme: JSON.stringify({
				headingFont: 'custom',
				headingCustomFont: {
					objectKey,
					filename: 'Display.woff2',
					format: 'woff2',
				},
			}),
		})
		.where(eq(Organization.id, organization.id))
	await db.insert(FontLicenceAcceptance).values({
		organizationId: organization.id,
		userId: user.id,
		agreementVersion: 1,
		role: 'heading',
		fileName: 'Display.woff2',
		fileHash: 'hash',
		objectKey,
	})
	return { organization, objectKey }
}

async function servedTheme(organization: { slug: string }) {
	const found = await findPublishedSiteOrganization({ slug: organization.slug })
	return toPublicSitePayload(found!).theme
}

describe('a font taken off a site is never served (#286)', () => {
	it('is served while the licence stands', async () => {
		const { organization } = await setup()
		const theme = await servedTheme(organization)
		expect(theme.headingCustomFont?.url).toContain('site-fonts')
	})

	it('drops a removed font even when a restored version or a scheduled publish names it again', async () => {
		const { organization, objectKey } = await setup()
		await db
			.update(FontLicenceAcceptance)
			.set({ removedAt: new Date(), removedBy: 'admin' })
			.where(
				and(
					eq(FontLicenceAcceptance.organizationId, organization.id),
					eq(FontLicenceAcceptance.objectKey, objectKey),
				),
			)
		// The live theme text still names the font (an old snapshot came back).
		const theme = await servedTheme(organization)
		expect(theme.headingCustomFont).toBeNull()
		expect(theme.headingFont).toBe('inter')
	})

	it('another organization is unaffected by a removal', async () => {
		const first = await setup()
		const second = await setup()
		await db
			.update(FontLicenceAcceptance)
			.set({ removedAt: new Date(), removedBy: 'admin' })
			.where(eq(FontLicenceAcceptance.organizationId, first.organization.id))
		expect((await servedTheme(first.organization)).headingCustomFont).toBeNull()
		expect(
			(await servedTheme(second.organization)).headingCustomFont,
		).not.toBeNull()
	})

	it('the font file itself answers 410 once removed', async () => {
		const { organization, objectKey } = await setup()
		const { loader } = await import('#app/routes/resources+/fonts.tsx')
		const call = () => {
			const url = new URL(
				`http://localhost:3001/resources/fonts?objectKey=${encodeURIComponent(objectKey)}`,
			)
			return loader({
				request: new Request(url),
				params: {},
				context: new RouterContextProvider(),
				url,
				pattern: '/resources/fonts',
			} as never) as Promise<Response>
		}
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('font', { status: 200 })),
		)
		expect((await call()).status).toBe(200)
		await db
			.update(FontLicenceAcceptance)
			.set({ removedAt: new Date(), removedBy: 'admin' })
			.where(eq(FontLicenceAcceptance.organizationId, organization.id))
		await expect(call()).rejects.toMatchObject({ status: 410 })
		vi.unstubAllGlobals()
	})
})
