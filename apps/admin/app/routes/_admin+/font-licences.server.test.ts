/**
 * #286, Admin: font acceptances per organization and removing a font after a
 * complaint, which sends the site back to the theme font at once.
 */
import { randomUUID } from 'node:crypto'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import {
	DEFAULT_SITE_THEME,
	parseSiteThemeConfig,
	serializeSiteThemeConfig,
} from '@repo/common/site-theme'
import {
	db,
	eq,
	FontLicenceAcceptance,
	Organization,
	Role,
	Session,
	User,
	_RoleToUser,
} from '@repo/database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	action,
	listFontAcceptances,
	loader,
	removeFontAsAdmin,
} from './font-licences.server.ts'

const purge = vi.hoisted(() => vi.fn())
vi.mock('#app/utils/sites-cache-purge.server.ts', () => ({
	requestSiteCachePurge: purge,
}))

const orgIds: string[] = []
afterEach(async () => {
	purge.mockClear()
	for (const id of orgIds.splice(0)) {
		await db.delete(Organization).where(eq(Organization.id, id))
	}
})

async function makeUser(label: string) {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({
			username: `${label}-${id.slice(0, 8)}`,
			email: `${label}-${id}@example.com`,
			name: `${label} person`,
		})
		.returning()
	return user!
}

const fontKey = (orgId: string, role: string, tag: string) =>
	`org/${orgId}/site-fonts/${role}/${tag}.woff2`

function themeWith(objectKey: string, role: 'heading' | 'body' = 'heading') {
	const font = { objectKey, filename: 'Brand.woff2', format: 'woff2' as const }
	return serializeSiteThemeConfig({
		...DEFAULT_SITE_THEME,
		...(role === 'heading'
			? { headingFont: 'custom' as const, headingCustomFont: font }
			: { bodyFont: 'custom' as const, bodyCustomFont: font }),
	})
}

async function makeOrgWithFont(options: { draftOnly?: boolean } = {}) {
	const member = await makeUser('member')
	const [organization] = await db
		.insert(Organization)
		.values({ name: 'Cafe', slug: `cafe-${randomUUID().slice(0, 8)}` })
		.returning()
	orgIds.push(organization!.id)
	const objectKey = fontKey(organization!.id, 'heading', randomUUID())
	const theme = themeWith(objectKey)
	await db
		.update(Organization)
		.set(
			options.draftOnly
				? { draftSiteTheme: theme }
				: { siteTheme: theme, draftSiteTheme: theme },
		)
		.where(eq(Organization.id, organization!.id))
	const [acceptance] = await db
		.insert(FontLicenceAcceptance)
		.values({
			organizationId: organization!.id,
			userId: member.id,
			agreementVersion: 1,
			role: 'heading',
			fileName: 'Brand.woff2',
			fileHash: 'a'.repeat(64),
			objectKey,
		})
		.returning()
	return {
		organization: organization!,
		member,
		acceptance: acceptance!,
		objectKey,
	}
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

async function adminCookie() {
	const admin = await makeUser('platform-admin')
	await db
		.insert(Role)
		.values({ name: 'admin', description: 'admin role' })
		.onConflictDoNothing()
	const role = await db.query.Role.findFirst({ where: eq(Role.name, 'admin') })
	await db.insert(_RoleToUser).values({ A: role!.id, B: admin.id })
	const [session] = await db
		.insert(Session)
		.values({ userId: admin.id, expirationDate: getSessionExpirationDate() })
		.returning()
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session!.id)
	return { admin, cookie: await authSessionStorage.commitSession(authSession) }
}

describe('Admin font licences (#286)', () => {
	it('lists acceptances per organization with member, file and whether the site uses it', async () => {
		const a = await makeOrgWithFont()
		const rows = await listFontAcceptances({ search: a.organization.slug })
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			organization: { id: a.organization.id, slug: a.organization.slug },
			member: a.member.name,
			role: 'heading',
			fileName: 'Brand.woff2',
			fileHash: 'a'.repeat(64),
			agreementVersion: 1,
			inUse: true,
			removedAt: null,
		})
	})

	it('removes a font: live and draft fall back to the theme font, the record is kept', async () => {
		const a = await makeOrgWithFont()
		const { admin } = await adminCookie()
		const result = await removeFontAsAdmin({
			adminUserId: admin.id,
			acceptanceId: a.acceptance.id,
			reason: 'Foundry complaint',
		})
		expect(result).toMatchObject({
			ok: true,
			removedFromLive: true,
			removedFromDraft: true,
		})
		const after = await themes(a.organization.id)
		for (const theme of [after.live, after.draft]) {
			expect(theme?.headingCustomFont).toBeNull()
			expect(theme?.headingFont).toBe('inter')
		}
		const [row] = await db
			.select()
			.from(FontLicenceAcceptance)
			.where(eq(FontLicenceAcceptance.id, a.acceptance.id))
		expect(row).toMatchObject({
			removedBy: 'admin',
			removedByUserId: admin.id,
			removedReason: 'Foundry complaint',
		})
		expect(row?.removedAt).toBeInstanceOf(Date)
		expect(purge).toHaveBeenCalledWith({ organizationId: a.organization.id })
		const listed = await listFontAcceptances({ search: a.organization.slug })
		expect(listed[0]).toMatchObject({ inUse: false })
		expect(listed[0]?.removedAt).toBeTruthy()
	})

	it('does not touch a font the organization already replaced', async () => {
		const a = await makeOrgWithFont()
		const { admin } = await adminCookie()
		const replacement = fontKey(a.organization.id, 'heading', 'newer')
		await db
			.update(Organization)
			.set({
				siteTheme: themeWith(replacement),
				draftSiteTheme: themeWith(replacement),
			})
			.where(eq(Organization.id, a.organization.id))
		const result = await removeFontAsAdmin({
			adminUserId: admin.id,
			acceptanceId: a.acceptance.id,
		})
		expect(result).toMatchObject({
			ok: true,
			removedFromLive: false,
			removedFromDraft: false,
		})
		const after = await themes(a.organization.id)
		expect(after.live?.headingCustomFont?.objectKey).toBe(replacement)
	})

	it('removes a font that only the unpublished draft uses', async () => {
		const a = await makeOrgWithFont({ draftOnly: true })
		const { admin } = await adminCookie()
		const result = await removeFontAsAdmin({
			adminUserId: admin.id,
			acceptanceId: a.acceptance.id,
		})
		expect(result).toMatchObject({ ok: true, removedFromDraft: true })
		expect(
			(await themes(a.organization.id)).draft?.headingCustomFont,
		).toBeNull()
	})

	it('answers 404 for an unknown acceptance', async () => {
		const { admin } = await adminCookie()
		expect(
			await removeFontAsAdmin({ adminUserId: admin.id, acceptanceId: 'nope' }),
		).toEqual({ ok: false, error: 'not_found' })
	})

	it('only an admin can open the list or remove a font', async () => {
		const a = await makeOrgWithFont()
		await expect(
			loader({
				request: new Request('http://localhost:3005/font-licences'),
				params: {},
				context: {},
			} as never),
		).rejects.toBeTruthy()
		await expect(
			action({
				request: new Request('http://localhost:3005/font-licences', {
					method: 'POST',
					body: new URLSearchParams({
						_action: 'remove-font',
						acceptanceId: a.acceptance.id,
					}),
				}),
				params: {},
				context: {},
			} as never),
		).rejects.toBeTruthy()
		expect(
			(await themes(a.organization.id)).live?.headingCustomFont,
		).not.toBeNull()

		const { cookie } = await adminCookie()
		const removed = (await action({
			request: new Request('http://localhost:3005/font-licences', {
				method: 'POST',
				headers: { Cookie: cookie },
				body: new URLSearchParams({
					_action: 'remove-font',
					acceptanceId: a.acceptance.id,
				}),
			}),
			params: {},
			context: {},
		} as never)) as Response
		expect(removed.status).toBe(200)
		expect((await themes(a.organization.id)).live?.headingCustomFont).toBeNull()
	})
})
