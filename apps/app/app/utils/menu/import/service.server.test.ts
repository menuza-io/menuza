import type * as featureFlagsModule from '@repo/common/feature-flags'
import { db, eq, MenuImport, Organization } from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	RouterContextProvider,
} from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	action as importDetailAction,
	loader as importDetailLoader,
} from '#app/routes/_app+/$orgSlug_+/menu+/import.$importId.tsx'
import {
	action as importAction,
	loader as importLoader,
} from '#app/routes/_app+/$orgSlug_+/menu+/import.tsx'
import { action as jobsMenuImportAction } from '#app/routes/resources+/jobs.menu-import.ts'
import type * as storageServer from '#app/utils/storage.server.ts'
import { insertTestMember, insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	cancelMenuImport,
	loadMenuImportForOrg,
	processMenuImportJob,
	startMenuImport,
} from './service.server.ts'

const featureMocks = vi.hoisted(() => ({
	featureFlagValue: 'true' as string | null,
	sourceStore: new Map<string, Uint8Array<ArrayBuffer>>(),
	draftStore: new Map<string, string>(),
}))

vi.mock('@repo/common/feature-flags', async (importOriginal) => {
	const actual = await importOriginal<typeof featureFlagsModule>()
	return {
		...actual,
		getFeatureFlag: vi.fn(async () => featureMocks.featureFlagValue),
	}
})

vi.mock('#app/utils/storage.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof storageServer>()
	return {
		...actual,
		uploadMenuImportSource: vi.fn(
			async (
				orgId: string,
				importId: string,
				ext: string,
				bytes: Uint8Array<ArrayBuffer>,
			) => {
				const key = `menu-imports/${orgId}/${importId}/source.${ext}`
				featureMocks.sourceStore.set(key, bytes)
				return key
			},
		),
		readMenuImportSource: vi.fn(
			async (key: string) => featureMocks.sourceStore.get(key) ?? null,
		),
		uploadMenuImportDraftJson: vi.fn(
			async (orgId: string, importId: string, json: string) => {
				const key = `menu-imports/${orgId}/${importId}/draft.json`
				featureMocks.draftStore.set(key, json)
				return key
			},
		),
		readMenuImportDraftJson: vi.fn(
			async (key: string) => featureMocks.draftStore.get(key) ?? null,
		),
		deleteMenuImportObject: vi.fn(async (key: string) => {
			featureMocks.sourceStore.delete(key)
			featureMocks.draftStore.delete(key)
		}),
	}
})

describe('menu import service, rate limits, isolation, and route guards (#73)', () => {
	const prevKillSwitch = process.env.MENU_IMPORT_ENABLED
	let organizationId = ''
	let organizationSlug = ''
	let userId = ''
	let adminCookie = ''

	beforeEach(async () => {
		vi.clearAllMocks()
		featureMocks.featureFlagValue = 'true'
		featureMocks.sourceStore.clear()
		featureMocks.draftStore.clear()
		delete process.env.MENU_IMPORT_ENABLED

		const user = await insertTestUser()
		const org = await createTestOrganization(user.id)
		organizationId = org.id
		organizationSlug = org.slug
		userId = user.id
		// Owner created via createTestOrganization has admin role; create session
		const { createTestSession } = await import('#tests/test-utils.ts')
		adminCookie = (await createTestSession(user.id)).cookie
	})

	afterEach(() => {
		process.env.MENU_IMPORT_ENABLED = prevKillSwitch
	})

	it('requires ownership confirmation for URL import and refuses concurrent imports (import_in_progress)', async () => {
		const noConfirm = await startMenuImport(
			{
				kind: 'url',
				organizationId,
				userId,
				sourceUrl: 'https://menu.example.com',
				confirmedOwnership: false,
			},
			{
				resolve: async () => ['93.184.216.34'],
				wakeWorkflow: async () => true,
			},
		)
		expect(noConfirm.ok).toBe(false)
		if (!noConfirm.ok) expect(noConfirm.error).toBe('ownership_not_confirmed')

		const first = await startMenuImport(
			{
				kind: 'url',
				organizationId,
				userId,
				sourceUrl: 'https://menu.example.com',
				confirmedOwnership: true,
			},
			{
				resolve: async () => ['93.184.216.34'],
				wakeWorkflow: async () => true,
			},
		)
		expect(first.ok).toBe(true)

		// Second import while first is queued/running is refused with import_in_progress
		const second = await startMenuImport(
			{
				kind: 'url',
				organizationId,
				userId,
				sourceUrl: 'https://menu.example.com/other',
				confirmedOwnership: true,
			},
			{
				resolve: async () => ['93.184.216.34'],
				wakeWorkflow: async () => true,
			},
		)
		expect(second.ok).toBe(false)
		if (!second.ok) {
			expect(second.status).toBe(409)
			expect(second.error).toBe('import_in_progress')
		}
	})

	it('enforces per-user (3/hour) and per-org (10/day) rate limits', async () => {
		const deps = {
			resolve: async () => ['93.184.216.34'],
			wakeWorkflow: async () => true,
		}

		// User 1 starts and cancels 3 imports (4th hits 3/user/hour limit)
		for (let i = 0; i < 3; i += 1) {
			const res = await startMenuImport(
				{
					kind: 'url',
					organizationId,
					userId,
					sourceUrl: `https://menu.example.com/p${i}`,
					confirmedOwnership: true,
				},
				deps,
			)
			expect(res.ok).toBe(true)
			if (res.ok)
				await cancelMenuImport({ importId: res.importId, organizationId })
		}

		const userBlocked = await startMenuImport(
			{
				kind: 'url',
				organizationId,
				userId,
				sourceUrl: 'https://menu.example.com/p4',
				confirmedOwnership: true,
			},
			deps,
		)
		expect(userBlocked.ok).toBe(false)
		if (!userBlocked.ok) {
			expect(userBlocked.status).toBe(429)
			expect(userBlocked.error).toBe('rate_limited')
		}

		// Additional users in the same org hit the 10/org/day ceiling
		for (let u = 0; u < 3; u += 1) {
			const member = await insertTestUser()
			const count = u < 2 ? 3 : 1 // total org imports = 3 + 3 + 3 + 1 = 10
			for (let j = 0; j < count; j += 1) {
				const res = await startMenuImport(
					{
						kind: 'url',
						organizationId,
						userId: member.id,
						sourceUrl: `https://menu.example.com/u${u}-${j}`,
						confirmedOwnership: true,
					},
					deps,
				)
				expect(res.ok).toBe(true)
				if (res.ok)
					await cancelMenuImport({ importId: res.importId, organizationId })
			}
		}

		const freshMember = await insertTestUser()
		const orgBlocked = await startMenuImport(
			{
				kind: 'url',
				organizationId,
				userId: freshMember.id,
				sourceUrl: 'https://menu.example.com/over-org-cap',
				confirmedOwnership: true,
			},
			deps,
		)
		expect(orgBlocked.ok).toBe(false)
		if (!orgBlocked.ok) {
			expect(orgBlocked.status).toBe(429)
			expect(orgBlocked.error).toBe('rate_limited')
		}
	})

	it('processes queued URL import to ready and isolates importIds per organization', async () => {
		const started = await startMenuImport(
			{
				kind: 'url',
				organizationId,
				userId,
				sourceUrl: 'https://bistro.example.com/menu',
				confirmedOwnership: true,
			},
			{
				resolve: async () => ['93.184.216.34'],
				wakeWorkflow: async () => true,
			},
		)
		expect(started.ok).toBe(true)
		if (!started.ok) return

		const processed = await processMenuImportJob(started.importId, {
			resolve: async () => ['93.184.216.34'],
			fetch: async () =>
				new Response(
					'<html><body><h2>Sides</h2><p>Fries $5</p></body></html>',
					{
						status: 200,
						headers: { 'content-type': 'text/html' },
					},
				),
			generator: async () => ({
				detectedCurrency: 'USD',
				detectedLocales: ['en'],
				menus: [
					{
						name: { en: 'Main Menu' },
						categories: [
							{
								name: { en: 'Sides' },
								items: [{ name: { en: 'Fries' }, price: 5 }],
							},
						],
					},
				],
			}),
		})

		expect(processed.ok).toBe(true)
		expect(processed.status).toBe('ready')

		const ownLoaded = await loadMenuImportForOrg({
			importId: started.importId,
			organizationId,
		})
		expect(ownLoaded?.draft?.menus[0]?.categories[0]?.items[0]?.name).toEqual({
			en: 'Fries',
		})

		// Another org cannot load or cancel this import
		const otherUser = await insertTestUser()
		const otherOrg = await createTestOrganization(otherUser.id)
		expect(
			await loadMenuImportForOrg({
				importId: started.importId,
				organizationId: otherOrg.id,
			}),
		).toBeNull()
		const crossCancel = await cancelMenuImport({
			importId: started.importId,
			organizationId: otherOrg.id,
		})
		expect(crossCancel.ok).toBe(false)
		if (!crossCancel.ok) expect(crossCancel.status).toBe(404)
	})

	it('enforces route guards: flag off (404), non-admin viewer (403), cross-org (404), kill switch (503), and internal auth on jobs route (401)', async () => {
		// 1. Flag off -> 404
		featureMocks.featureFlagValue = 'false'
		await expect(
			importLoader({
				request: new Request(
					`https://app.example/${organizationSlug}/menu/import`,
					{
						headers: { cookie: adminCookie },
					},
				),
				params: { orgSlug: organizationSlug },
				context: new RouterContextProvider(),
			} as unknown as LoaderFunctionArgs),
		).rejects.toMatchObject({ status: 404 })

		// 2. Flag on, member with viewer role (no update:menu:any) -> 403
		featureMocks.featureFlagValue = 'true'
		const member = await insertTestMember(organizationId)
		const {
			db: database,
			OrganizationRole,
			UserOrganization,
			and: andOp,
		} = await import('@repo/database')
		const viewerRole = await database.query.OrganizationRole.findFirst({
			where: eq(OrganizationRole.id, 'org_role_viewer'),
		})
		if (viewerRole) {
			await database
				.update(UserOrganization)
				.set({ organizationRoleId: viewerRole.id })
				.where(
					andOp(
						eq(UserOrganization.userId, member.user.id),
						eq(UserOrganization.organizationId, organizationId),
					),
				)
		}
		await expect(
			importLoader({
				request: new Request(
					`https://app.example/${organizationSlug}/menu/import`,
					{
						headers: { cookie: member.cookie },
					},
				),
				params: { orgSlug: organizationSlug },
				context: new RouterContextProvider(),
			} as unknown as LoaderFunctionArgs),
		).rejects.toMatchObject({ status: 403 })

		// 3. Cross-org access to detail loader -> 404
		const [imp] = await db
			.insert(MenuImport)
			.values({
				organizationId,
				sourceKind: 'url',
				sourceUrl: 'https://menu.example.com',
				status: 'queued',
				createdById: userId,
			})
			.returning()
		const outsider = await insertTestUser()
		const outsiderOrg = await createTestOrganization(outsider.id)
		const { createTestSession } = await import('#tests/test-utils.ts')
		const outsiderCookie = (await createTestSession(outsider.id)).cookie
		await expect(
			importDetailLoader({
				request: new Request(
					`https://app.example/${outsiderOrg.slug}/menu/import/${imp!.id}`,
					{ headers: { cookie: outsiderCookie } },
				),
				params: { orgSlug: outsiderOrg.slug, importId: imp!.id },
				context: new RouterContextProvider(),
			} as unknown as LoaderFunctionArgs),
		).rejects.toMatchObject({ status: 404 })

		// 4. Kill switch -> 503 on action
		process.env.MENU_IMPORT_ENABLED = 'false'
		const killRes = await importAction({
			request: new Request(
				`https://app.example/${organizationSlug}/menu/import`,
				{
					method: 'POST',
					headers: { cookie: adminCookie },
					body: new FormData(),
				},
			),
			params: { orgSlug: organizationSlug },
			context: new RouterContextProvider(),
		} as unknown as ActionFunctionArgs)
		expect(killRes.status).toBe(503)

		const detailKillRes = await importDetailAction({
			request: new Request(
				`https://app.example/${organizationSlug}/menu/import/${imp!.id}`,
				{
					method: 'POST',
					headers: {
						cookie: adminCookie,
						'content-type': 'application/json',
					},
					body: JSON.stringify({ intent: 'cancel' }),
				},
			),
			params: { orgSlug: organizationSlug, importId: imp!.id },
			context: new RouterContextProvider(),
		} as unknown as ActionFunctionArgs)
		expect(detailKillRes.status).toBe(503)

		// 5. Internal jobs route rejects missing/invalid bearer token
		await expect(
			jobsMenuImportAction({
				request: new Request('https://app.example/resources/jobs/menu-import', {
					method: 'POST',
					headers: {
						Authorization: 'Bearer invalid-token',
						'content-type': 'application/json',
					},
					body: JSON.stringify({ importId: imp!.id }),
				}),
				params: {},
				context: new RouterContextProvider(),
			} as unknown as ActionFunctionArgs),
		).rejects.toMatchObject({ status: 401 })

		// 6. Sanity check org still untouched
		const orgCheck = await db.query.Organization.findFirst({
			where: eq(Organization.id, organizationId),
		})
		expect(orgCheck?.id).toBe(organizationId)
	})
})
