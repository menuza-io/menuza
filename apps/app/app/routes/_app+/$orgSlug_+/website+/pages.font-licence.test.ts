import { FONT_LICENCE_VERSION, sha256Hex } from '@repo/common/font-licence'
import { parseSiteThemeConfig } from '@repo/common/site-theme'
import {
	and,
	db,
	eq,
	FontLicenceAcceptance,
	Organization,
	WebsitePage,
} from '@repo/database'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as storageModule from '#app/utils/storage.server.ts'
import { uploadSiteFont } from '#app/utils/storage.server.ts'
import { server } from '#tests/mocks/index.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './pages.$pageId.tsx'

// Storage is the external boundary; the licence checks and records are real.
vi.mock('#app/utils/storage.server.ts', async (importOriginal) => ({
	...(await importOriginal<typeof storageModule>()),
	uploadSiteFont: vi.fn(
		async (organizationId: string, role: string) =>
			`org/${organizationId}/site-fonts/${role}/${Math.random()}.woff2`,
	),
	getSignedGetRequestInfoAsync: vi.fn(async () => ({
		url: 'https://storage.test/font',
		headers: {},
	})),
}))

afterEach(() => {
	vi.mocked(uploadSiteFont).mockClear()
	vi.unstubAllGlobals()
})

const FONT_BYTES = new Uint8Array([
	0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0, 1, 2, 3, 4,
])

async function setup() {
	const { user, organization, cookie } = await setupTestOrgWithUser('admin')
	const [page] = await db
		.insert(WebsitePage)
		.values({
			organizationId: organization.id,
			createdById: user.id,
			title: 'Home',
			slug: `home-${Math.random()}`,
			isHomePage: true,
		} as never)
		.returning({ id: WebsitePage.id })
	return { user, organization, cookie, pageId: page!.id }
}

async function upload(
	ctx: {
		organization: { id: string; slug: string }
		cookie: string
		pageId: string
	},
	fields: Record<string, string> = {},
	role = 'heading',
) {
	const body = new FormData()
	body.set('intent', 'upload-site-font')
	body.set('organizationId', ctx.organization.id)
	body.set('role', role)
	body.set(
		'fontFile',
		new File([FONT_BYTES], 'Brand Sans.woff2', { type: 'font/woff2' }),
	)
	for (const [key, value] of Object.entries(fields)) body.set(key, value)
	return post(ctx, body)
}

async function post(
	ctx: { organization: { slug: string }; cookie: string; pageId: string },
	body: FormData | URLSearchParams,
) {
	try {
		return (await action({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${ctx.organization.slug}/website/pages/${ctx.pageId}`,
				{ method: 'POST', body },
				ctx.cookie,
			),
			params: { orgSlug: ctx.organization.slug, pageId: ctx.pageId },
			context: {},
		} as never)) as Response
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

async function rows(organizationId: string) {
	return db
		.select()
		.from(FontLicenceAcceptance)
		.where(eq(FontLicenceAcceptance.organizationId, organizationId))
}

async function themes(organizationId: string) {
	const [org] = await db
		.select({
			siteTheme: Organization.siteTheme,
			draftSiteTheme: Organization.draftSiteTheme,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
	return {
		live: org?.siteTheme ? parseSiteThemeConfig(org.siteTheme) : null,
		draft: org?.draftSiteTheme
			? parseSiteThemeConfig(org.draftSiteTheme)
			: null,
	}
}

const ticked = {
	fontLicenceAccepted: 'true',
	fontLicenceVersion: String(FONT_LICENCE_VERSION),
}

describe('uploading a custom font needs the licence agreement (#286)', () => {
	it('refuses an upload without the box ticked and stores nothing', async () => {
		const ctx = await setup()
		const res = await upload(ctx)
		expect(res.status).toBe(403)
		expect(await res.json()).toMatchObject({ code: 'font_agreement_required' })
		expect(uploadSiteFont).not.toHaveBeenCalled()
		expect(await rows(ctx.organization.id)).toHaveLength(0)
		expect((await themes(ctx.organization.id)).draft).toBeNull()
	})

	it('refuses a tick for another version of the text', async () => {
		const ctx = await setup()
		const res = await upload(ctx, {
			fontLicenceAccepted: 'true',
			fontLicenceVersion: '0',
		})
		expect(res.status).toBe(403)
		expect(uploadSiteFont).not.toHaveBeenCalled()
	})

	it('records the member, time, file name and hash when the box is ticked', async () => {
		const ctx = await setup()
		const before = Date.now()
		const res = await upload(ctx, ticked)
		expect(res.status).toBe(200)
		const [row] = await rows(ctx.organization.id)
		expect(row).toMatchObject({
			organizationId: ctx.organization.id,
			userId: ctx.user.id,
			agreementVersion: FONT_LICENCE_VERSION,
			role: 'heading',
			fileName: 'Brand Sans.woff2',
			fileHash: await sha256Hex(FONT_BYTES),
		})
		expect(row!.objectKey).toContain('/site-fonts/heading/')
		expect(row!.acceptedAt.getTime()).toBeGreaterThanOrEqual(before - 1000)
		expect(row!.removedAt).toBeNull()
		const { draft } = await themes(ctx.organization.id)
		expect(draft?.headingCustomFont?.objectKey).toBe(row!.objectKey)
	})

	it('does not ask the same member again for this version', async () => {
		const ctx = await setup()
		expect((await upload(ctx, ticked)).status).toBe(200)
		expect((await upload(ctx, {}, 'body')).status).toBe(200)
		expect(await rows(ctx.organization.id)).toHaveLength(2)
	})

	it('asks every other member separately', async () => {
		const ctx = await setup()
		expect((await upload(ctx, ticked)).status).toBe(200)
		const other = await createTestUser()
		await addOrganizationMember(other.id, ctx.organization.id, 'org_role_admin')
		const otherCookie = (await createTestSession(other.id)).cookie
		const res = await upload({ ...ctx, cookie: otherCookie })
		expect(res.status).toBe(403)
		expect(await res.json()).toMatchObject({ code: 'font_agreement_required' })
	})

	it('asks again when the agreement text changes (a new version)', async () => {
		const ctx = await setup()
		// Accepted an older text only.
		await db.insert(FontLicenceAcceptance).values({
			organizationId: ctx.organization.id,
			userId: ctx.user.id,
			agreementVersion: FONT_LICENCE_VERSION - 1,
			role: 'body',
			fileName: 'old.woff2',
			fileHash: 'abc',
			objectKey: 'org/x/site-fonts/body/old.woff2',
		})
		const res = await upload(ctx)
		expect(res.status).toBe(403)
		expect(uploadSiteFont).not.toHaveBeenCalled()
	})

	it('still refuses files that are not fonts after the box is ticked', async () => {
		const ctx = await setup()
		const body = new FormData()
		body.set('intent', 'upload-site-font')
		body.set('organizationId', ctx.organization.id)
		body.set('role', 'heading')
		body.set('fontLicenceAccepted', 'true')
		body.set('fontLicenceVersion', String(FONT_LICENCE_VERSION))
		body.set('fontFile', new File(['<script>alert(1)</script>'], 'x.woff2'))
		const res = await post(ctx, body)
		expect(res.status).toBe(400)
		expect(await rows(ctx.organization.id)).toHaveLength(0)
	})
})

describe('Design shows the uploader and Remove font falls back at once (#286)', () => {
	async function load(ctx: Awaited<ReturnType<typeof setup>>) {
		server.use(
			http.get('http://localhost:3007/operator/forms', () =>
				HttpResponse.json({ forms: [] }),
			),
		)
		return (await loader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${ctx.organization.slug}/website/pages/${ctx.pageId}`,
				{},
				ctx.cookie,
			),
			params: { orgSlug: ctx.organization.slug, pageId: ctx.pageId },
			context: {},
		} as never)) as unknown as {
			fontLicence: {
				accepted: boolean
				fonts: Record<
					string,
					{
						uploader: string | null
						uploadedAt: string | null
						needsConfirmation: boolean
					}
				>
			}
		}
	}

	it('names the uploader and the date', async () => {
		const ctx = await setup()
		await upload(ctx, ticked)
		const data = await load(ctx)
		expect(data.fontLicence.accepted).toBe(true)
		expect(data.fontLicence.fonts.heading).toMatchObject({
			uploader: expect.any(String),
			needsConfirmation: false,
		})
		expect(data.fontLicence.fonts.heading?.uploadedAt).toBeTruthy()
	})

	it('removes a font from the live and the draft theme and marks the acceptance removed', async () => {
		const ctx = await setup()
		await upload(ctx, ticked)
		// A published site still serves the font by reference.
		const { draft } = await themes(ctx.organization.id)
		await db
			.update(Organization)
			.set({ siteTheme: JSON.stringify(draft), draftSiteTheme: null })
			.where(eq(Organization.id, ctx.organization.id))
		expect(
			(await themes(ctx.organization.id)).live?.headingCustomFont,
		).not.toBeNull()

		const body = new URLSearchParams()
		body.set('intent', 'delete-site-font')
		body.set('organizationId', ctx.organization.id)
		body.set('role', 'heading')
		const res = await post(ctx, body)
		expect(res.status).toBe(200)

		const after = await themes(ctx.organization.id)
		expect(after.live?.headingCustomFont).toBeNull()
		expect(after.live?.headingFont).toBe('inter')
		expect(after.draft?.headingCustomFont ?? null).toBeNull()
		const [row] = await rows(ctx.organization.id)
		expect(row?.removedAt).toBeInstanceOf(Date)
		expect(row?.removedBy).toBe('owner')
		expect(row?.removedByUserId).toBe(ctx.user.id)
	})

	it('asks the member to confirm a font uploaded before the agreement', async () => {
		const ctx = await setup()
		const objectKey = `org/${ctx.organization.id}/site-fonts/body/legacy.woff2`
		await db
			.update(Organization)
			.set({
				siteTheme: JSON.stringify({
					bodyFont: 'custom',
					bodyCustomFont: {
						objectKey,
						filename: 'Legacy.woff2',
						format: 'woff2',
					},
				}),
			})
			.where(eq(Organization.id, ctx.organization.id))
		const data = await load(ctx)
		expect(data.fontLicence.fonts.body).toMatchObject({
			needsConfirmation: true,
			uploader: null,
		})

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(FONT_BYTES, { status: 200 })),
		)
		const refused = new URLSearchParams()
		refused.set('intent', 'confirm-site-font-licence')
		refused.set('role', 'body')
		expect((await post(ctx, refused)).status).toBe(403)

		const body = new URLSearchParams()
		body.set('intent', 'confirm-site-font-licence')
		body.set('role', 'body')
		body.set('fontLicenceAccepted', 'true')
		// Only the current text can be confirmed.
		body.set('fontLicenceVersion', String(FONT_LICENCE_VERSION + 1))
		expect((await post(ctx, body)).status).toBe(403)
		body.set('fontLicenceVersion', String(FONT_LICENCE_VERSION))
		expect((await post(ctx, body)).status).toBe(200)
		const [row] = await db
			.select()
			.from(FontLicenceAcceptance)
			.where(
				and(
					eq(FontLicenceAcceptance.organizationId, ctx.organization.id),
					eq(FontLicenceAcceptance.objectKey, objectKey),
				),
			)
		expect(row).toMatchObject({
			userId: ctx.user.id,
			fileName: 'Legacy.woff2',
			fileHash: await sha256Hex(FONT_BYTES),
		})
		expect((await load(ctx)).fontLicence.fonts.body?.needsConfirmation).toBe(
			false,
		)
	})

	it('confirming covers the file that is live and the file in the draft, each by its own hash', async () => {
		const ctx = await setup()
		const liveKey = `org/${ctx.organization.id}/site-fonts/body/live.woff2`
		const draftKey = `org/${ctx.organization.id}/site-fonts/body/draft.woff2`
		const themeWith = (objectKey: string, filename: string) =>
			JSON.stringify({
				bodyFont: 'custom',
				bodyCustomFont: { objectKey, filename, format: 'woff2' },
			})
		await db
			.update(Organization)
			.set({
				siteTheme: themeWith(liveKey, 'Live.woff2'),
				draftSiteTheme: themeWith(draftKey, 'Draft.woff2'),
			})
			.where(eq(Organization.id, ctx.organization.id))
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(FONT_BYTES, { status: 200 })),
		)
		const body = new URLSearchParams()
		body.set('intent', 'confirm-site-font-licence')
		body.set('role', 'body')
		body.set('fontLicenceAccepted', 'true')
		body.set('fontLicenceVersion', String(FONT_LICENCE_VERSION))
		expect((await post(ctx, body)).status).toBe(200)
		const recorded = await rows(ctx.organization.id)
		expect(recorded.map((row) => row.objectKey).sort()).toEqual(
			[draftKey, liveKey].sort(),
		)
		// A second tick records nothing twice.
		expect((await post(ctx, body)).status).toBe(200)
		expect(await rows(ctx.organization.id)).toHaveLength(2)
	})
})
