/**
 * #194 and the operator side of #89: versioned Menuza agreements, an
 * append-only record of who accepted what and when, owners only, never while
 * impersonating, and a required-by date that blocks the dashboard.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type * as AuthModule from '@repo/auth'
import {
	and,
	db,
	eq,
	gt,
	LegalAcceptance,
	LegalAgreement,
	Organization,
	UserOrganization,
	WebsitePage,
	WebsiteVersion,
} from '@repo/database'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	acceptAgreements,
	agreementPromptFor,
	copySignupAcceptances,
	isOrganizationOwner,
	latestAgreements,
	listAcceptances,
	pendingAgreementsFor,
	recordSignupAcceptance,
	requireModuleAgreement,
} from './agreements.server.ts'

const impersonating = vi.hoisted(() => ({ value: false }))
vi.mock('@repo/auth', async (importOriginal) => {
	const actual = await importOriginal<typeof AuthModule>()
	return {
		...actual,
		isImpersonating: vi.fn(async () => impersonating.value),
	}
})

const request = new Request('http://localhost:3000/x', {
	headers: { 'x-forwarded-for': '203.0.113.7' },
})

// Organizations a test made, removed afterwards (their acceptances go with
// them: the table is append-only, but a deleted organization takes its rows),
// then the agreement versions the test published, so every test starts from
// version 1 of each agreement.
const createdOrganizations: string[] = []

async function setup(role: 'admin' | 'member' = 'admin') {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, role)
	createdOrganizations.push(organization.id)
	return { user, organization }
}

afterEach(async () => {
	for (const id of createdOrganizations.splice(0)) {
		await db.delete(Organization).where(eq(Organization.id, id))
	}
	await db.delete(LegalAgreement).where(gt(LegalAgreement.version, 1))
})

/** Publishes a new version of an agreement the way Admin does. */
async function publish(
	key: string,
	version: number,
	extra: { requiredBy?: Date | null; scope?: string } = {},
) {
	await db.insert(LegalAgreement).values({
		key,
		version,
		title: JSON.stringify({ en: `${key} v${version}` }),
		url: `/${key}`,
		summary: JSON.stringify({ en: 'What changed' }),
		scope: extra.scope ?? (key === 'payments' ? 'module' : 'always'),
		requiredBy: extra.requiredBy ?? null,
	})
}

const pendingKeys = async (organizationId: string, now?: Date) =>
	(await pendingAgreementsFor(organizationId, now))
		.map((agreement) => `${agreement.key}:${agreement.version}`)
		.sort()

beforeEach(() => {
	impersonating.value = false
})

describe('agreement versions', () => {
	it('starts with version 1 of the five agreements', async () => {
		const latest = await latestAgreements()
		const byKey = Object.fromEntries(latest.map((row) => [row.key, row]))
		for (const key of [
			'terms',
			'privacy',
			'dpa',
			'payments',
			'text_marketing',
		]) {
			expect(byKey[key]?.version).toBeGreaterThanOrEqual(1)
		}
		expect(byKey.payments?.scope).toBe('module')
		expect(byKey.text_marketing?.scope).toBe('module')
		expect(byKey.terms?.scope).toBe('always')
	})
})

describe('pending agreements', () => {
	it('an organization with no acceptance owes the always-on agreements, not the module ones', async () => {
		const { organization } = await setup()
		const keys = await pendingKeys(organization.id)
		expect(keys).toEqual(
			expect.arrayContaining(['dpa:1', 'privacy:1', 'terms:1']),
		)
		expect(keys.some((key) => key.startsWith('payments'))).toBe(false)
		expect(keys.some((key) => key.startsWith('text_marketing'))).toBe(false)
	})

	it('records the acceptance with version, time and an IP hash, once', async () => {
		const { user, organization } = await setup()
		const now = new Date('2026-12-01T10:00:00Z')
		const result = await acceptAgreements({
			request,
			userId: user.id,
			organizationId: organization.id,
			items: [
				{ key: 'terms', version: 1 },
				{ key: 'privacy', version: 1 },
				{ key: 'dpa', version: 1 },
			],
			now,
		})
		expect(result.ok).toBe(true)
		const rows = await db
			.select()
			.from(LegalAcceptance)
			.where(eq(LegalAcceptance.organizationId, organization.id))
		expect(rows).toHaveLength(3)
		for (const row of rows) {
			expect(row.userId).toBe(user.id)
			expect(row.version).toBe(1)
			expect(row.acceptedAt.toISOString()).toBe(now.toISOString())
			expect(row.source).toBe('dialog')
			// An HMAC, never the address.
			expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/)
			expect(row.ipHash).not.toContain('203.0.113.7')
		}
		expect(await pendingKeys(organization.id)).toEqual([])
		// Accepting again records nothing more.
		await acceptAgreements({
			request,
			userId: user.id,
			organizationId: organization.id,
			items: [{ key: 'terms', version: 1 }],
		})
		expect(
			await db
				.select({ id: LegalAcceptance.id })
				.from(LegalAcceptance)
				.where(eq(LegalAcceptance.organizationId, organization.id)),
		).toHaveLength(3)
		const listed = await listAcceptances(organization.id)
		expect(listed.map((row) => row.key).sort()).toEqual([
			'dpa',
			'privacy',
			'terms',
		])
		expect(listed.every((row) => row.acceptedBy)).toBe(true)
	})

	it('a new version prompts the owner once and records the acceptance', async () => {
		const { user, organization } = await setup()
		await acceptAgreements({
			request,
			userId: user.id,
			organizationId: organization.id,
			items: [
				{ key: 'terms', version: 1 },
				{ key: 'privacy', version: 1 },
				{ key: 'dpa', version: 1 },
			],
		})
		expect(await pendingKeys(organization.id)).toEqual([])

		await publish('terms', 2)
		expect(await pendingKeys(organization.id)).toEqual(['terms:2'])
		// An old version can no longer be accepted.
		expect(
			await acceptAgreements({
				request,
				userId: user.id,
				organizationId: organization.id,
				items: [{ key: 'terms', version: 1 }],
			}),
		).toEqual({ ok: false, error: 'superseded' })
		expect(
			(
				await acceptAgreements({
					request,
					userId: user.id,
					organizationId: organization.id,
					items: [{ key: 'terms', version: 2 }],
				})
			).ok,
		).toBe(true)
		// Prompted once: nothing is pending any more, and the history keeps both.
		expect(await pendingKeys(organization.id)).toEqual([])
		const versions = (await listAcceptances(organization.id))
			.filter((row) => row.key === 'terms')
			.map((row) => row.version)
			.sort()
		expect(versions).toEqual([1, 2])
	})
})

describe('who may accept', () => {
	it('only an owner (admin role) can; a member cannot and is never asked', async () => {
		const { organization } = await setup('admin')
		const member = await insertTestUser()
		await db.insert(UserOrganization).values({
			userId: member.id,
			organizationId: organization.id,
			organizationRoleId: 'org_role_member',
		})
		expect(await isOrganizationOwner(member.id, organization.id)).toBe(false)
		expect(
			await acceptAgreements({
				request,
				userId: member.id,
				organizationId: organization.id,
				items: [{ key: 'terms', version: 1 }],
			}),
		).toEqual({ ok: false, error: 'not_owner' })
		expect(
			await db
				.select({ id: LegalAcceptance.id })
				.from(LegalAcceptance)
				.where(eq(LegalAcceptance.organizationId, organization.id)),
		).toHaveLength(0)
		const prompt = await agreementPromptFor({
			request,
			userId: member.id,
			organizationId: organization.id,
		})
		expect(prompt).toEqual({ pending: [], blocking: false, canAccept: false })
	})

	it('impersonating staff can never accept on a restaurant’s behalf', async () => {
		const { user, organization } = await setup()
		impersonating.value = true
		expect(
			await acceptAgreements({
				request,
				userId: user.id,
				organizationId: organization.id,
				items: [{ key: 'terms', version: 1 }],
			}),
		).toEqual({ ok: false, error: 'impersonating' })
		expect(
			await db
				.select({ id: LegalAcceptance.id })
				.from(LegalAcceptance)
				.where(eq(LegalAcceptance.organizationId, organization.id)),
		).toHaveLength(0)
		// They can still look at the dashboard: never blocked, but cannot accept.
		await publish('privacy', 2, {
			requiredBy: new Date(Date.now() - 86_400_000),
		})
		const prompt = await agreementPromptFor({
			request,
			userId: user.id,
			organizationId: organization.id,
		})
		expect(prompt.pending.length).toBeGreaterThan(0)
		expect(prompt.blocking).toBe(false)
		expect(prompt.canAccept).toBe(false)
	})

	it('refuses an unknown agreement and an empty request', async () => {
		const { user, organization } = await setup()
		expect(
			await acceptAgreements({
				request,
				userId: user.id,
				organizationId: organization.id,
				items: [{ key: 'nope', version: 1 }],
			}),
		).toEqual({ ok: false, error: 'unknown_agreement' })
		expect(
			await acceptAgreements({
				request,
				userId: user.id,
				organizationId: organization.id,
				items: [],
			}),
		).toEqual({ ok: false, error: 'nothing_to_accept' })
	})
})

describe('required by', () => {
	it('can be postponed before the date and blocks the dashboard after it', async () => {
		const { user, organization } = await setup()
		await acceptAgreements({
			request,
			userId: user.id,
			organizationId: organization.id,
			items: [
				{ key: 'terms', version: 1 },
				{ key: 'privacy', version: 1 },
				{ key: 'dpa', version: 1 },
			],
		})
		const requiredBy = new Date('2026-12-31T00:00:00Z')
		await publish('dpa', 2, { requiredBy })
		const before = await agreementPromptFor({
			request,
			userId: user.id,
			organizationId: organization.id,
			now: new Date('2026-12-30T23:59:59Z'),
		})
		expect(before.pending.map((a) => a.key)).toEqual(['dpa'])
		expect(before.blocking).toBe(false)
		expect(before.canAccept).toBe(true)
		const after = await agreementPromptFor({
			request,
			userId: user.id,
			organizationId: organization.id,
			now: new Date('2026-12-31T00:00:00Z'),
		})
		expect(after.pending[0]!.overdue).toBe(true)
		expect(after.blocking).toBe(true)
	})
})

describe('module agreements', () => {
	it('turning on payments asks for the payment terms first, once', async () => {
		const { user, organization } = await setup()
		const pending = await requireModuleAgreement(organization.id, 'payments')
		expect(pending).toMatchObject({ key: 'payments', version: 1 })
		await acceptAgreements({
			request,
			userId: user.id,
			organizationId: organization.id,
			items: [{ key: 'payments', version: 1 }],
			source: 'module',
		})
		expect(await requireModuleAgreement(organization.id, 'payments')).toBeNull()
		const [row] = await db
			.select()
			.from(LegalAcceptance)
			.where(
				and(
					eq(LegalAcceptance.organizationId, organization.id),
					eq(LegalAcceptance.agreementKey, 'payments'),
				),
			)
		expect(row!.source).toBe('module')
	})

	it('text marketing is asked separately', async () => {
		const { organization } = await setup()
		expect(
			await requireModuleAgreement(organization.id, 'text_marketing'),
		).toMatchObject({ key: 'text_marketing' })
	})
})

describe('sign-up (#194)', () => {
	it('stores the accepted Terms and Privacy versions for the new person, and the organization inherits them', async () => {
		const user = await insertTestUser()
		const recorded = await recordSignupAcceptance({ userId: user.id, request })
		expect(recorded.map((r) => r.key).sort()).toEqual(['privacy', 'terms'])
		const signupRows = await db
			.select()
			.from(LegalAcceptance)
			.where(eq(LegalAcceptance.userId, user.id))
		expect(signupRows).toHaveLength(2)
		for (const row of signupRows) {
			expect(row.organizationId).toBeNull()
			expect(row.source).toBe('signup')
			expect(row.version).toBe(1)
		}
		// Recording twice changes nothing.
		await recordSignupAcceptance({ userId: user.id, request })
		expect(
			await db
				.select({ id: LegalAcceptance.id })
				.from(LegalAcceptance)
				.where(eq(LegalAcceptance.userId, user.id)),
		).toHaveLength(2)

		const organization = await createTestOrganization(user.id, 'admin')
		createdOrganizations.push(organization.id)
		expect(
			await copySignupAcceptances({
				userId: user.id,
				organizationId: organization.id,
			}),
		).toBe(2)
		// Only the Data processing agreement is left to accept.
		expect(await pendingKeys(organization.id)).toEqual(['dpa:1'])
	})

	it('signup() itself records the versions', async () => {
		const { signup } = await import('#app/utils/auth.server.ts')
		const id = crypto.randomUUID().slice(0, 8)
		const session = await signup({
			email: `signup-${id}@example.com`,
			username: `signup${id}`,
			name: 'New Owner',
			password: 'a-long-password-123',
			request,
		})
		const rows = await db
			.select({ key: LegalAcceptance.agreementKey })
			.from(LegalAcceptance)
			.where(eq(LegalAcceptance.userId, session.userId))
		expect(rows.map((row) => row.key).sort()).toEqual(['privacy', 'terms'])
	})
})

describe('append-only acceptances', () => {
	it('refuses every update and delete, but a deleted organization takes its rows with it', async () => {
		const { user, organization } = await setup()
		await acceptAgreements({
			request,
			userId: user.id,
			organizationId: organization.id,
			items: [{ key: 'terms', version: 1 }],
		})
		await expect(
			db
				.update(LegalAcceptance)
				.set({ version: 9 })
				.where(eq(LegalAcceptance.organizationId, organization.id)),
		).rejects.toThrow()
		await expect(
			db
				.delete(LegalAcceptance)
				.where(eq(LegalAcceptance.organizationId, organization.id)),
		).rejects.toThrow()
		expect(
			await db
				.select({ id: LegalAcceptance.id })
				.from(LegalAcceptance)
				.where(eq(LegalAcceptance.organizationId, organization.id)),
		).toHaveLength(1)

		// Sign-up rows (no organization) cannot be deleted either.
		await recordSignupAcceptance({ userId: user.id })
		await expect(
			db.delete(LegalAcceptance).where(eq(LegalAcceptance.userId, user.id)),
		).rejects.toThrow()

		// Deleting the organization cascades.
		await db.delete(Organization).where(eq(Organization.id, organization.id))
		expect(
			await db
				.select({ id: LegalAcceptance.id })
				.from(LegalAcceptance)
				.where(eq(LegalAcceptance.organizationId, organization.id)),
		).toHaveLength(0)
	})
})

describe('migration backfill (#194, #85)', () => {
	const migration = readFileSync(
		path.resolve(
			__dirname,
			'../../../../../packages/database/drizzle/0064_website_publishing.sql',
		),
		'utf8',
	)
	const statement = (marker: string) => {
		const start = migration.indexOf(marker)
		expect(start).toBeGreaterThan(-1)
		const rest = migration.slice(start)
		const end = rest.indexOf('--> statement-breakpoint')
		return (end === -1 ? rest : rest.slice(0, end)).replace(/^--.*$/gm, '')
	}

	it('records existing organizations as accepted at sign-up, version 1, on their creation date', async () => {
		const { user, organization } = await setup()
		const created = new Date('2025-06-01T08:00:00Z')
		await db
			.update(Organization)
			.set({ createdAt: created })
			.where(eq(Organization.id, organization.id))
		await db.run(
			sql.raw(
				statement(
					'INSERT INTO `LegalAcceptance` (`id`, `agreementKey`, `version`, `organizationId`',
				),
			),
		)
		const rows = await db
			.select()
			.from(LegalAcceptance)
			.where(eq(LegalAcceptance.organizationId, organization.id))
		expect(rows.map((row) => row.agreementKey).sort()).toEqual([
			'privacy',
			'terms',
		])
		for (const row of rows) {
			expect(row.version).toBe(1)
			expect(row.source).toBe('backfill')
			expect(row.acceptedAt.toISOString()).toBe(created.toISOString())
			expect(row.userId).toBe(user.id)
		}
		// The data processing agreement is still owed.
		expect(await pendingKeys(organization.id)).toEqual(['dpa:1'])
	})

	it('starts every published page, the chrome and the theme with a first version', async () => {
		const { user, organization } = await setup()
		await db
			.update(Organization)
			.set({
				siteHeaderConfig: '{"h":1}',
				siteFooterConfig: '{"f":1}',
				siteTheme: '{"mode":"dark"}',
			})
			.where(eq(Organization.id, organization.id))
		const [page] = await db
			.insert(WebsitePage)
			.values({
				organizationId: organization.id,
				createdById: user.id,
				title: 'Live',
				slug: 'live',
				status: 'published',
				publishedData: '[{"type":"text","config":"{}"}]',
			})
			.returning({ id: WebsitePage.id })
		await db.insert(WebsitePage).values({
			organizationId: organization.id,
			createdById: user.id,
			title: 'Never published',
			slug: 'never',
		})
		for (const marker of [
			'INSERT INTO `WebsiteVersion` (`id`, `organizationId`, `pageId`, `kind`, `title`, `slug`, `snapshot`, `contentHash`, `summary`, `publishedById`, `publishedAt`)\nSELECT lower(hex(randomblob(12))), `p`.',
			"SELECT lower(hex(randomblob(12))), `o`.`id`, NULL, 'chrome'",
			"SELECT lower(hex(randomblob(12))), `o`.`id`, NULL, 'theme'",
		]) {
			const start = migration.indexOf(marker)
			expect(start).toBeGreaterThan(-1)
			// Each backfill statement is the INSERT header plus its SELECT.
			const headerStart = migration.lastIndexOf(
				'INSERT INTO `WebsiteVersion`',
				start,
			)
			const rest = migration.slice(headerStart)
			const end = rest.indexOf('--> statement-breakpoint')
			await db.run(
				sql.raw(
					(end === -1 ? rest : rest.slice(0, end)).replace(/^--.*$/gm, ''),
				),
			)
		}
		const versions = await db
			.select()
			.from(WebsiteVersion)
			.where(eq(WebsiteVersion.organizationId, organization.id))
		expect(versions.map((v) => v.kind).sort()).toEqual([
			'chrome',
			'page',
			'theme',
		])
		const pageVersion = versions.find((v) => v.kind === 'page')!
		expect(pageVersion.pageId).toBe(page!.id)
		expect(pageVersion.snapshot).toBe('[{"type":"text","config":"{}"}]')
		expect(
			JSON.parse(versions.find((v) => v.kind === 'chrome')!.snapshot),
		).toEqual({
			header: '{"h":1}',
			footer: '{"f":1}',
		})
		expect(versions.find((v) => v.kind === 'theme')!.snapshot).toBe(
			'{"mode":"dark"}',
		)
	})
})
