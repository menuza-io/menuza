import {
	db,
	eq,
	Integration,
	IntegrationLog,
	MenuSyncOutbox,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import {
	importCatalog,
	integrationManager,
	pruneOldIntegrationLogs,
	pushMenu,
	sandboxUrls,
} from '@repo/integrations'
import {
	posSandboxHandlers,
	resetPosSandbox,
} from '@repo/integrations/pos/sandbox'
import { http, HttpResponse } from 'msw'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { action as pruneJobAction } from '#app/routes/resources+/jobs.integration-log-prune.ts'
import { INTEGRATION_FLAG_KEYS } from '#app/utils/integrations/flags.server.ts'
import { server } from '#tests/mocks/index.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	action as historyAction,
	loader as historyLoader,
} from './integrations.$integrationId.history.ts'

const flags = vi.hoisted(() => ({ on: new Set<string>() }))
vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: vi.fn(async (key: string) => flags.on.has(key)),
}))

async function createOrgWithSandboxIntegration(
	providerName: 'square' | 'doordash' = 'doordash',
) {
	const { user, organization, cookie } = await setupTestOrgWithUser('admin')
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: JSON.stringify({ en: 'Main Kitchen' }),
			slug: `main-kitchen-${Date.now()}`,
			isDefault: true,
		})
		.returning()

	const [integration] = await db
		.insert(Integration)
		.values({
			organizationId: organization.id,
			organizationLocationId: location!.id,
			providerName,
			providerType: providerName === 'doordash' ? 'delivery' : 'pos',
			isActive: true,
			config: JSON.stringify({
				environment: 'sandbox',
				merchantId:
					providerName === 'doordash' ? 'dd-store-1' : 'sq-merchant-1',
			}),
		})
		.returning()

	const [menu] = await db
		.insert(OrganizationMenu)
		.values({
			organizationId: organization.id,
			displayName: JSON.stringify({ en: 'All Day' }),
		})
		.returning()

	const [category] = await db
		.insert(OrganizationMenuCategory)
		.values({
			organizationId: organization.id,
			displayName: JSON.stringify({ en: 'Mains' }),
		})
		.returning()

	await db.insert(OrganizationMenuCategoryAssignment).values({
		menuId: menu!.id,
		categoryId: category!.id,
	})

	const [item] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId: organization.id,
			displayName: JSON.stringify({ en: 'Margherita' }),
			price: 12.5,
			availabilityStatus: 'available',
		})
		.returning()

	await db.insert(OrganizationMenuItemCategoryAssignment).values({
		categoryId: category!.id,
		itemId: item!.id,
	})

	return {
		user,
		organization,
		cookie,
		location: location!,
		integration: integration!,
		menu: menu!,
		item: item!,
	}
}

async function callHistoryLoader(
	orgSlug: string,
	integrationId: string,
	cookie: string,
	query = '',
) {
	const url = new URL(
		`http://localhost:3001/${orgSlug}/settings/integrations/${integrationId}/history${query}`,
	)
	return (await historyLoader({
		request: createAuthenticatedRequest(
			url.toString(),
			{ method: 'GET' },
			cookie,
		),
		params: { orgSlug, integrationId },
		context: new RouterContextProvider(),
		url,
		pattern: '/:orgSlug/settings/integrations/:integrationId/history',
	})) as Response
}

async function callHistoryAction(
	orgSlug: string,
	integrationId: string,
	cookie: string,
	form: Record<string, string>,
) {
	const url = new URL(
		`http://localhost:3001/${orgSlug}/settings/integrations/${integrationId}/history`,
	)
	const body = new URLSearchParams(form)
	return (await historyAction({
		request: createAuthenticatedRequest(
			url.toString(),
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: body.toString(),
			},
			cookie,
		),
		params: { orgSlug, integrationId },
		context: new RouterContextProvider(),
		url,
		pattern: '/:orgSlug/settings/integrations/:integrationId/history',
	})) as Response
}

const menuSyncWakeHandler = http.post(
	'http://localhost:8787/workflows/menu-sync/start',
	() => HttpResponse.json({ success: true }),
)

describe('integration sync history route & 90-day pruning (#94)', () => {
	beforeEach(() => {
		flags.on.clear()
		resetPosSandbox()
		server.use(...posSandboxHandlers, menuSyncWakeHandler)
	})

	afterEach(() => {
		server.resetHandlers()
	})

	it('returns 404 when integrationId belongs to another organization', async () => {
		const orgA = await createOrgWithSandboxIntegration('doordash')
		const orgB = await createOrgWithSandboxIntegration('doordash')

		let loaderStatus = 0
		try {
			const res = await callHistoryLoader(
				orgA.organization.slug,
				orgB.integration.id,
				orgA.cookie,
			)
			loaderStatus = res.status
		} catch (error) {
			loaderStatus = (error as Response).status
		}
		expect(loaderStatus).toBe(404)

		const [foreignLog] = await db
			.insert(IntegrationLog)
			.values({
				integrationId: orgB.integration.id,
				action: 'pos_push',
				status: 'error',
				requestData: JSON.stringify({ menuId: orgB.menu.id }),
				errorMessage: 'Failed',
			})
			.returning()

		const actionRes = await callHistoryAction(
			orgA.organization.slug,
			orgB.integration.id,
			orgA.cookie,
			{ intent: 'retry', logId: foreignLog!.id },
		)
		expect(actionRes.status).toBe(404)
	})

	it('returns 403 for members lacking update:settings:any permission', async () => {
		const orgA = await createOrgWithSandboxIntegration('doordash')
		const member = await createTestUser()
		await addOrganizationMember(
			member.id,
			orgA.organization.id,
			'org_role_member',
		)
		const memberSession = await createTestSession(member.id)

		let loaderStatus = 0
		try {
			const res = await callHistoryLoader(
				orgA.organization.slug,
				orgA.integration.id,
				memberSession.cookie,
			)
			loaderStatus = res.status
		} catch (error) {
			loaderStatus = (error as Response).status
		}
		expect(loaderStatus).toBe(403)

		let actionStatus = 0
		try {
			const res = await callHistoryAction(
				orgA.organization.slug,
				orgA.integration.id,
				memberSession.cookie,
				{ intent: 'retry', logId: 'log_1' },
			)
			actionStatus = res.status
		} catch (error) {
			actionStatus = (error as Response).status
		}
		expect(actionStatus).toBe(403)
	})

	it('lists imports and pushes with counts, filters failures-only, and never returns tokens or raw responseData', async () => {
		const { organization, cookie, integration, menu } =
			await createOrgWithSandboxIntegration('square')

		await importCatalog(integration.id, organization.id, menu.id)
		await pushMenu(integration.id, organization.id, menu.id)

		// Log an entry with simulated secret values and raw responseData to verify storage + DTO redaction
		const secretToken = 'sq0atp-very-secret-token-999'
		const rawSecretResponse = 'RAW_PLATFORM_SECRET_BODY_DO_NOT_RETURN'
		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_push',
			'error',
			{
				provider: 'square',
				menuId: menu.id,
				menuName: 'All Day',
				accessToken: secretToken,
				pushed: 0,
			},
			new Error(`Upstream error with Bearer ${secretToken} and ?code=oauth123`),
			{
				access_token: secretToken,
				rawMarker: rawSecretResponse,
			},
		)

		const storedLogs = await db
			.select()
			.from(IntegrationLog)
			.where(eq(IntegrationLog.integrationId, integration.id))

		expect(storedLogs.length).toBeGreaterThanOrEqual(3)
		for (const row of storedLogs) {
			const serializedRow = JSON.stringify(row)
			expect(serializedRow).not.toContain(secretToken)
			expect(serializedRow).not.toContain('oauth123')
		}

		const allRes = await callHistoryLoader(
			organization.slug,
			integration.id,
			cookie,
		)
		expect(allRes.status).toBe(200)
		const allBody = (await allRes.json()) as {
			entries: Array<{
				id: string
				kind: string
				status: string
				itemCounts: Record<string, unknown> | null
				errorMessage: string | null
				retryable: boolean
			}>
		}
		const rawJsonBody = JSON.stringify(allBody)
		expect(rawJsonBody).not.toContain(secretToken)
		expect(rawJsonBody).not.toContain(rawSecretResponse)
		expect(rawJsonBody).not.toContain('responseData')

		expect(allBody.entries.length).toBeGreaterThanOrEqual(3)

		const pushErrorEntry = allBody.entries.find(
			(e) => e.kind === 'push' && e.status === 'error',
		)
		expect(pushErrorEntry?.retryable).toBe(true)
		expect(pushErrorEntry?.errorMessage).toContain('Bearer [REDACTED]')

		const importEntry = allBody.entries.find((e) => e.kind === 'import')
		expect(importEntry?.status).toBe('success')
		expect(importEntry?.itemCounts).toMatchObject({
			created: expect.any(Number),
			updated: expect.any(Number),
			skipped: expect.any(Number),
			menuId: menu.id,
			menuName: 'All Day',
		})

		const pushSuccessEntry = allBody.entries.find(
			(e) => e.kind === 'push' && e.status === 'success',
		)
		expect(pushSuccessEntry?.itemCounts).toMatchObject({
			pushed: expect.any(Number),
			menuId: menu.id,
			menuName: 'All Day',
		})

		const failuresRes = await callHistoryLoader(
			organization.slug,
			integration.id,
			cookie,
			'?status=error',
		)
		expect(failuresRes.status).toBe(200)
		const failuresBody = (await failuresRes.json()) as typeof allBody
		expect(failuresBody.entries).toHaveLength(1)
		expect(failuresBody.entries[0]?.status).toBe('error')
	})

	it('retries a failed push directly when auto_sync is off and via outbox when auto_sync is on', async () => {
		const { organization, cookie, integration, menu } =
			await createOrgWithSandboxIntegration('doordash')

		server.use(
			http.put(`${sandboxUrls.doordash}/api/v1/stores/*/menus`, () =>
				HttpResponse.json(
					{ message: 'Service unavailable', token: 'dd-secret-token' },
					{ status: 503, headers: { 'x-pos-sandbox': 'true' } },
				),
			),
		)

		await expect(
			pushMenu(integration.id, organization.id, menu.id),
		).rejects.toThrow()

		// Restore healthy sandbox handlers before retrying
		server.resetHandlers()
		server.use(...posSandboxHandlers, menuSyncWakeHandler)

		const listRes = await callHistoryLoader(
			organization.slug,
			integration.id,
			cookie,
			'?status=error',
		)
		const listBody = (await listRes.json()) as {
			entries: Array<{ id: string; errorMessage: string | null }>
		}
		expect(listBody.entries).toHaveLength(1)
		const failedLog = listBody.entries[0]!
		expect(failedLog.errorMessage).toContain('temporarily unavailable')
		expect(failedLog.errorMessage).not.toContain('dd-secret-token')

		// 1. Direct retry (auto_sync off)
		const directRetryRes = await callHistoryAction(
			organization.slug,
			integration.id,
			cookie,
			{ intent: 'retry', logId: failedLog.id },
		)
		expect(directRetryRes.status).toBe(200)
		const directRetryBody = (await directRetryRes.json()) as {
			ok: boolean
			mode: string
			pushed: number
		}
		expect(directRetryBody).toMatchObject({
			ok: true,
			mode: 'direct',
			pushed: 1,
		})

		// 2. Queued retry via enqueueMenuSync (#74) when auto_sync is on
		flags.on.add(INTEGRATION_FLAG_KEYS.autoSync)
		const queuedRetryRes = await callHistoryAction(
			organization.slug,
			integration.id,
			cookie,
			{ intent: 'retry', logId: failedLog.id },
		)
		expect(queuedRetryRes.status).toBe(200)
		expect(await queuedRetryRes.json()).toMatchObject({
			ok: true,
			mode: 'queued',
		})
		const outboxRows = await db
			.select()
			.from(MenuSyncOutbox)
			.where(eq(MenuSyncOutbox.integrationId, integration.id))
		expect(outboxRows).toHaveLength(1)
		expect(outboxRows[0]?.kind).toBe('menu')
		expect(outboxRows[0]?.status).toBe('queued')
	})

	it('prunes IntegrationLog rows older than 90 days via pruneOldIntegrationLogs and the internal job route', async () => {
		const { integration } = await createOrgWithSandboxIntegration('doordash')
		const now = new Date()
		const ninetyOneDaysAgo = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000)
		const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)

		const [oldLog] = await db
			.insert(IntegrationLog)
			.values({
				integrationId: integration.id,
				action: 'pos_push',
				status: 'success',
				createdAt: ninetyOneDaysAgo,
			})
			.returning()
		const [recentLog] = await db
			.insert(IntegrationLog)
			.values({
				integrationId: integration.id,
				action: 'pos_push',
				status: 'success',
				createdAt: tenDaysAgo,
			})
			.returning()

		const url = new URL(
			'http://localhost:3001/resources/jobs/integration-log-prune',
		)
		const jobRes = (await pruneJobAction({
			request: new Request(url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
				},
			}),
			params: {},
			context: new RouterContextProvider(),
			url,
			pattern: '/resources/jobs/integration-log-prune',
		})) as Response

		expect(jobRes.status).toBe(200)
		const jobBody = (await jobRes.json()) as {
			success: boolean
			deleted: number
		}
		expect(jobBody.success).toBe(true)
		expect(jobBody.deleted).toBeGreaterThanOrEqual(1)

		const remaining = await db
			.select({ id: IntegrationLog.id })
			.from(IntegrationLog)
			.where(eq(IntegrationLog.integrationId, integration.id))
		expect(remaining.map((r) => r.id)).toContain(recentLog!.id)
		expect(remaining.map((r) => r.id)).not.toContain(oldLog!.id)

		// Also verify explicit retentionDays parameter works directly
		const secondPass = await pruneOldIntegrationLogs(90, now)
		expect(secondPass.deleted).toBe(0)
	})
})
