import {
	and,
	db,
	eq,
	Integration,
	IntegrationLog,
	OrganizationLocation,
} from '@repo/database'
import {
	merchantIds,
	parsePosConfig,
	sandboxUrls,
	type PosProvider,
} from '@repo/integrations'
import {
	getSandboxPauseState,
	posSandboxHandlers,
	resetPosSandbox,
} from '@repo/integrations/pos/sandbox'
import { http, HttpResponse } from 'msw'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	action as integrationsAction,
	loader as integrationsLoader,
} from '#app/routes/_app+/$orgSlug_+/settings+/integrations.tsx'
import { action as menuSyncJobAction } from '#app/routes/resources+/jobs.menu-sync.ts'
import {
	reconcileDeliveryPauses,
	retryDeliveryPause,
} from '#app/utils/integrations/delivery-pause.server.ts'
import { INTEGRATION_FLAG_KEYS } from '#app/utils/integrations/flags.server.ts'
import {
	applyOrderingControl,
	loadOrderingControls,
} from '#app/utils/location/ordering-controls.server.ts'
import { server } from '#tests/mocks/index.ts'
import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'

const flags = vi.hoisted(() => ({ on: new Set<string>() }))
vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: vi.fn(async (key: string) => flags.on.has(key)),
}))

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(true),
}))

const wakeRequests: Array<{ runAt: string }> = []
const menuSyncWakeHandler = http.post(
	'http://localhost:8787/workflows/menu-sync/start',
	async ({ request }) => {
		const body = (await request.json().catch(() => ({}))) as { runAt?: string }
		if (body.runAt) wakeRequests.push({ runAt: body.runAt })
		return HttpResponse.json({ success: true })
	},
)

async function seedLocationWithIntegrations(providers: PosProvider[]) {
	const { organization, cookie } = await setupTestOrgWithUser('admin')
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: JSON.stringify({ en: 'Downtown' }),
			slug: `downtown-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			timezone: 'America/New_York',
			isDefault: true,
		})
		.returning()

	const integrations: Record<string, typeof Integration.$inferSelect> = {}
	for (const provider of providers) {
		const [row] = await db
			.insert(Integration)
			.values({
				organizationId: organization.id,
				organizationLocationId: location!.id,
				providerName: provider,
				providerType:
					provider === 'ubereats' || provider === 'doordash'
						? 'delivery'
						: 'pos',
				isActive: true,
				config: JSON.stringify({
					environment: 'sandbox',
					merchantId: merchantIds[provider],
				}),
			})
			.returning()
		integrations[provider] = row!
	}
	return { organization, cookie, location: location!, integrations }
}

describe('delivery store pause (#95)', () => {
	beforeEach(() => {
		flags.on.clear()
		flags.on.add(INTEGRATION_FLAG_KEYS.deliveryPause)
		wakeRequests.length = 0
		resetPosSandbox()
		server.use(...posSandboxHandlers, menuSyncWakeHandler)
	})

	afterEach(() => {
		server.resetHandlers()
	})

	it('no-ops when integrations.delivery_pause flag is off', async () => {
		flags.on.clear()
		const { organization, location, integrations } =
			await seedLocationWithIntegrations(['ubereats', 'doordash'])

		const result = await applyOrderingControl({
			organization,
			userId: null,
			control: {
				intent: 'pause',
				locationId: location.id,
				duration: '30m',
			},
			request: new Request('https://app.test/orders/ordering-controls', {
				method: 'POST',
			}),
		})
		expect(result).toEqual({ ok: true })
		expect(getSandboxPauseState(integrations.ubereats!.id)).toBeNull()
		expect(getSandboxPauseState(integrations.doordash!.id)).toBeNull()

		const controls = await loadOrderingControls(organization.id)
		expect(controls[0]?.hasDeliveryConnections).toBeUndefined()
	})

	it('AC #1: pauses delivery stores for 30m until the exact same time, leaves POS terminals unpaused, and ignores busy mode', async () => {
		const { organization, location, integrations } =
			await seedLocationWithIntegrations(['ubereats', 'doordash', 'square'])

		const now = new Date('2026-11-24T18:00:00.000Z')
		const expectedUntil = new Date('2026-11-24T18:30:00.000Z').toISOString()

		const pauseResult = await applyOrderingControl({
			organization,
			userId: null,
			control: {
				intent: 'pause',
				locationId: location.id,
				duration: '30m',
			},
			request: new Request('https://app.test/orders/ordering-controls', {
				method: 'POST',
			}),
			now,
		})
		expect(pauseResult).toEqual({ ok: true })
		expect(getSandboxPauseState(integrations.ubereats!.id)).toEqual({
			pausedUntil: expectedUntil,
		})
		expect(getSandboxPauseState(integrations.doordash!.id)).toEqual({
			pausedUntil: expectedUntil,
		})
		// Square POS terminal must NEVER be paused.
		expect(getSandboxPauseState(integrations.square!.id)).toBeNull()

		// Wakeup scheduled for the pause end timestamp.
		await vi.waitFor(() => {
			expect(wakeRequests.some((r) => r.runAt === expectedUntil)).toBe(true)
		})

		// Logged to IntegrationLog with action 'pos_pause'.
		const logs = await db
			.select()
			.from(IntegrationLog)
			.where(
				and(
					eq(IntegrationLog.integrationId, integrations.ubereats!.id),
					eq(IntegrationLog.action, 'pos_pause'),
				),
			)
		expect(logs).toHaveLength(1)
		expect(logs[0]?.status).toBe('success')

		// Busy mode must NOT call provider.pause or change delivery pause state.
		const busySpy = vi.fn()
		server.use(
			http.post(
				`${sandboxUrls.ubereats}/v2/eats/stores/${merchantIds.ubereats}/pause`,
				() => {
					busySpy()
					return HttpResponse.json({ pausedUntil: null })
				},
			),
		)
		await applyOrderingControl({
			organization,
			userId: null,
			control: {
				intent: 'busy',
				locationId: location.id,
				minutes: 20,
				duration: 'rest_of_day',
			},
			request: new Request('https://app.test/orders/ordering-controls', {
				method: 'POST',
			}),
			now,
		})
		expect(busySpy).not.toHaveBeenCalled()
	})

	it('AC #2: resuming resumes delivery stores, and an expired timed pause resumes within a minute via reconcile/job sweep', async () => {
		const { organization, location, integrations } =
			await seedLocationWithIntegrations(['ubereats', 'doordash'])

		const t0 = new Date('2026-11-24T18:00:00.000Z')
		await applyOrderingControl({
			organization,
			userId: null,
			control: {
				intent: 'pause',
				locationId: location.id,
				duration: '30m',
			},
			request: new Request('https://app.test/orders/ordering-controls', {
				method: 'POST',
			}),
			now: t0,
		})
		expect(getSandboxPauseState(integrations.ubereats!.id)?.pausedUntil).toBe(
			'2026-11-24T18:30:00.000Z',
		)

		// Manual resume immediately resumes both delivery stores.
		await applyOrderingControl({
			organization,
			userId: null,
			control: { intent: 'resume', locationId: location.id },
			request: new Request('https://app.test/orders/ordering-controls', {
				method: 'POST',
			}),
			now: new Date('2026-11-24T18:10:00.000Z'),
		})
		expect(getSandboxPauseState(integrations.ubereats!.id)).toEqual({
			pausedUntil: null,
		})
		expect(getSandboxPauseState(integrations.doordash!.id)).toEqual({
			pausedUntil: null,
		})

		// Pause again for 15m and let it expire, then verify sweep resumes it cleanly.
		const t1 = new Date('2026-11-24T19:00:00.000Z')
		await applyOrderingControl({
			organization,
			userId: null,
			control: {
				intent: 'pause',
				locationId: location.id,
				duration: '15m',
			},
			request: new Request('https://app.test/orders/ordering-controls', {
				method: 'POST',
			}),
			now: t1,
		})
		expect(getSandboxPauseState(integrations.ubereats!.id)?.pausedUntil).toBe(
			'2026-11-24T19:15:00.000Z',
		)

		// Before expiry: nothing resumed.
		const beforeExpiry = await reconcileDeliveryPauses({
			organizationId: organization.id,
			now: new Date('2026-11-24T19:14:30.000Z'),
		})
		expect(beforeExpiry.resumed).toBe(0)
		expect(getSandboxPauseState(integrations.ubereats!.id)?.pausedUntil).toBe(
			'2026-11-24T19:15:00.000Z',
		)

		// Within 1 minute after expiry (via MenuSyncWorkflow / /resources/jobs/menu-sync): resumes both!
		vi.useFakeTimers()
		try {
			vi.setSystemTime(new Date('2026-11-24T19:15:30.000Z'))
			const token =
				typeof ENV.INTERNAL_COMMAND_TOKEN === 'string' &&
				ENV.INTERNAL_COMMAND_TOKEN
					? ENV.INTERNAL_COMMAND_TOKEN
					: (process.env.INTERNAL_COMMAND_TOKEN ?? '')
			const jobRes = await menuSyncJobAction({
				request: new Request('http://localhost/resources/jobs/menu-sync', {
					method: 'POST',
					headers: { Authorization: `Bearer ${token}` },
				}),
				params: {},
				context: new RouterContextProvider(),
			} as never)
			expect(jobRes.status).toBe(200)
			const jobJson = (await jobRes.json()) as {
				deliveryPausesResumed: number
			}
			expect(jobJson.deliveryPausesResumed).toBeGreaterThanOrEqual(2)
			expect(getSandboxPauseState(integrations.ubereats!.id)).toEqual({
				pausedUntil: null,
			})
			expect(getSandboxPauseState(integrations.doordash!.id)).toEqual({
				pausedUntil: null,
			})
		} finally {
			vi.useRealTimers()
		}
	})

	it('handles open-ended pauses on Uber Eats (null) and DoorDash (24h cap + renewal)', async () => {
		const { organization, location, integrations } =
			await seedLocationWithIntegrations(['ubereats', 'doordash'])

		const t0 = new Date('2026-11-24T12:00:00.000Z')
		await applyOrderingControl({
			organization,
			userId: null,
			control: {
				intent: 'pause',
				locationId: location.id,
				duration: 'until_resumed',
			},
			request: new Request('https://app.test/orders/ordering-controls', {
				method: 'POST',
			}),
			now: t0,
		})

		// Uber Eats supports open-ended (`null`); DoorDash gets 24h cap (`t0 + 24h`).
		expect(getSandboxPauseState(integrations.ubereats!.id)).toEqual({
			pausedUntil: null,
		})
		const initialDdEnd = new Date(t0.getTime() + 24 * 60 * 60_000).toISOString()
		expect(getSandboxPauseState(integrations.doordash!.id)).toEqual({
			pausedUntil: initialDdEnd,
		})

		// 23h 30m later (inside renewal lead window): DoorDash is renewed for another 24h.
		const t23h30 = new Date(t0.getTime() + (23 * 60 + 30) * 60_000)
		const renewed = await reconcileDeliveryPauses({
			organizationId: organization.id,
			now: t23h30,
		})
		expect(renewed.renewed).toBe(1)
		expect(renewed.resumed).toBe(0)
		expect(getSandboxPauseState(integrations.doordash!.id)).toEqual({
			pausedUntil: new Date(t23h30.getTime() + 24 * 60 * 60_000).toISOString(),
		})
	})

	it('AC #3: keeps Menuza location paused on platform failure, surfaces failure + Retry, and succeeds once platform recovers', async () => {
		const { organization, cookie, location, integrations } =
			await seedLocationWithIntegrations(['ubereats', 'doordash'])

		// DoorDash fails with 503 while Uber Eats stays healthy.
		let doorDashFailing = true
		server.use(
			http.post(
				`${sandboxUrls.doordash}/api/v1/stores/${merchantIds.doordash}/pause`,
				async ({ request }) => {
					if (doorDashFailing) {
						return HttpResponse.json(
							{ message: 'DoorDash down Bearer secret-dd-tok' },
							{ status: 503, headers: { 'x-pos-sandbox': 'true' } },
						)
					}
					const data = (await request.json()) as { until?: string | null }
					return HttpResponse.json(
						{ pausedUntil: data.until ?? null },
						{ status: 200, headers: { 'x-pos-sandbox': 'true' } },
					)
				},
			),
		)

		const now = new Date()
		const expectedPausedUntil = new Date(
			now.getTime() + 30 * 60_000,
		).toISOString()
		const pauseResult = await applyOrderingControl({
			organization,
			userId: null,
			control: {
				intent: 'pause',
				locationId: location.id,
				duration: '30m',
			},
			request: new Request('https://app.test/orders/ordering-controls', {
				method: 'POST',
			}),
			now,
		})

		expect(pauseResult).toMatchObject({
			ok: true,
			deliveryPauseError: 'platform_pause_failed',
			failedDeliveryStores: [
				{
					integrationId: integrations.doordash!.id,
					providerName: 'doordash',
					displayName: 'DoorDash',
				},
			],
		})

		// Location MUST stay paused in Menuza, and Uber Eats was paused.
		const [locRow] = await db
			.select()
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, location.id))
		expect(locRow?.orderingPausedAt).not.toBeNull()
		expect(locRow?.orderingPausedUntil?.toISOString()).toBe(expectedPausedUntil)
		expect(getSandboxPauseState(integrations.ubereats!.id)?.pausedUntil).toBe(
			expectedPausedUntil,
		)

		// No secret token stored in Integration.config or IntegrationLog.
		const [ddRow] = await db
			.select()
			.from(Integration)
			.where(eq(Integration.id, integrations.doordash!.id))
		expect(ddRow?.config).not.toContain('secret-dd-tok')
		const ddPauseConfig = parsePosConfig(ddRow?.config).pause
		expect(ddPauseConfig?.lastPauseError).toBeTruthy()

		// loadOrderingControls exposes hasDeliveryConnections & deliveryPauseFailures.
		const controls = await loadOrderingControls(organization.id, now)
		expect(controls[0]?.hasDeliveryConnections).toBe(true)
		expect(controls[0]?.deliveryPauseFailures).toHaveLength(1)
		expect(controls[0]?.deliveryPauseFailures?.[0]?.integrationId).toBe(
			integrations.doordash!.id,
		)

		// Settings > Integrations loader exposes pausedUntil on Uber Eats and lastPauseError on DoorDash.
		const settingsUrl = `http://localhost:3001/${organization.slug}/settings/integrations?locationId=${location.id}`
		const loaderData = (await integrationsLoader({
			request: createAuthenticatedRequest(
				settingsUrl,
				{ method: 'GET' },
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
			url: new URL(settingsUrl),
			pattern: '/:orgSlug/settings/integrations',
		} as never)) as {
			deliveryPauseEnabled: boolean
			integrations: Array<{
				id: string
				pausedUntil?: string | null
				lastPauseError?: string | null
			}>
		}
		expect(loaderData.deliveryPauseEnabled).toBe(true)
		const uberCard = loaderData.integrations.find(
			(i) => i.id === integrations.ubereats!.id,
		)
		const ddCard = loaderData.integrations.find(
			(i) => i.id === integrations.doordash!.id,
		)
		expect(uberCard?.pausedUntil).toBe(expectedPausedUntil)
		expect(ddCard?.lastPauseError).toBeTruthy()

		// Platform recovers -> Retry succeeds!
		doorDashFailing = false
		const retryNow = new Date(now.getTime() + 2 * 60_000)
		const retryRes = await retryDeliveryPause(
			organization.id,
			integrations.doordash!.id,
			{ now: retryNow },
		)
		expect(retryRes).toEqual({
			ok: true,
			status: 'paused',
			integrationId: integrations.doordash!.id,
			providerName: 'doordash',
		})

		const afterControls = await loadOrderingControls(organization.id, retryNow)
		expect(afterControls[0]?.deliveryPauseFailures).toBeUndefined()

		// Also verify settings action retry-delivery-pause works cleanly.
		const body = new URLSearchParams({
			intent: 'retry-delivery-pause',
			integrationId: integrations.doordash!.id,
			organizationLocationId: location.id,
		})
		const actionRes = (await integrationsAction({
			request: createAuthenticatedRequest(
				settingsUrl,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: body.toString(),
				},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
			url: new URL(settingsUrl),
			pattern: '/:orgSlug/settings/integrations',
		} as never)) as Response
		expect(actionRes.status).toBe(302)
	})
})
