import {
	and,
	ConfigFlag,
	db,
	eq,
	GbpLocationSync,
	Integration,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnqueueGbpPush = vi.fn(async (..._args: unknown[]) => ({ ok: true }))
const mockPushLocationToGoogle = vi.fn(async (..._args: unknown[]) => ({
	ok: true,
}))
const mockPullLocation = vi.fn(async (..._args: unknown[]) => ({ ok: true }))
const mockRefreshVerification = vi.fn(async (..._args: unknown[]) => ({
	ok: true,
}))
const mockRefreshOrderLinks = vi.fn(async (..._args: unknown[]) => ({
	ok: true,
}))
const mockPublishMenu = vi.fn(async (..._args: unknown[]) => ({
	ok: true,
	result: { status: 'published' as const },
}))
const mockAddNewDishPhotos = vi.fn(async (..._args: unknown[]) => 0)
const mockFetchLocationMetrics = vi.fn(
	async (
		..._args: unknown[]
	): Promise<{ status: 'fetched' | 'backfilled' | 'skipped' | 'failed' }> => ({
		status: 'backfilled',
	}),
)

vi.mock('./sync.server.ts', () => ({
	enqueueGbpPush: (...args: unknown[]) => mockEnqueueGbpPush(...args),
	pushLocationToGoogle: (...args: unknown[]) =>
		mockPushLocationToGoogle(...args),
	pullLocation: (...args: unknown[]) => mockPullLocation(...args),
}))
vi.mock('./verification.server.ts', () => ({
	refreshVerification: (...args: unknown[]) => mockRefreshVerification(...args),
}))
vi.mock('./order-links.server.ts', () => ({
	refreshOrderLinks: (...args: unknown[]) => mockRefreshOrderLinks(...args),
}))
vi.mock('./menu.server.ts', () => ({
	publishMenu: (...args: unknown[]) => mockPublishMenu(...args),
	addNewDishPhotos: (...args: unknown[]) => mockAddNewDishPhotos(...args),
}))
vi.mock('./metrics.server.ts', () => ({
	fetchLocationMetrics: (...args: unknown[]) =>
		mockFetchLocationMetrics(...args),
}))

import {
	markGbpMenuDirty,
	onOrderingControlChangedGbp,
	runDailyGbpMetricsSweep,
	runHourlyGbpSweep,
} from './sweep.server.ts'

async function enableFlag(organizationId: string, key: string) {
	await db.insert(ConfigFlag).values({
		key,
		level: 'organization',
		organizationId,
		value: true,
	})
}

async function seedLinkedLocation(opts?: {
	syncEnabled?: boolean
	verificationState?: string
	menuDirtyAt?: Date | null
	menuSyncEnabled?: boolean
	metricsBackfilledAt?: Date | null
	pushRequestedAt?: Date | null
	orderingPausedAt?: Date | null
	orderingPausedUntil?: Date | null
}) {
	const [org] = await db
		.insert(Organization)
		.values({
			name: 'GBP Sweep Org',
			slug: `gbp-sweep-${crypto.randomUUID().slice(0, 8)}`,
			dataRegion: 'us',
		})
		.returning()
	if (!org) throw new Error('Failed to create test org')
	const [loc] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: org.id,
			name: 'Main Branch',
			slug: 'main-branch',
			timezone: 'America/New_York',
			isActive: true,
			isDefault: true,
			orderingPausedAt: opts?.orderingPausedAt ?? null,
			orderingPausedUntil: opts?.orderingPausedUntil ?? null,
		})
		.returning()
	const [integration] = await db
		.insert(Integration)
		.values({
			organizationId: org.id,
			organizationLocationId: loc!.id,
			providerName: 'google-business-profile',
			providerType: 'reviews',
			isActive: true,
			config: JSON.stringify({
				googleAccountName: 'accounts/1',
				googleLocationName: `locations/${loc!.id}`,
			}),
		})
		.returning()
	const [sync] = await db
		.insert(GbpLocationSync)
		.values({
			organizationId: org.id,
			organizationLocationId: loc!.id,
			integrationId: integration!.id,
			googleLocationName: `locations/${loc!.id}`,
			syncEnabled: opts?.syncEnabled ?? true,
			fieldsSynced: JSON.stringify(['name', 'hours', 'phone', 'links']),
			verificationState: opts?.verificationState ?? 'verified',
			menuSyncEnabled: opts?.menuSyncEnabled ?? true,
			menuDirtyAt: opts?.menuDirtyAt ?? null,
			metricsBackfilledAt: opts?.metricsBackfilledAt ?? null,
			pushRequestedAt: opts?.pushRequestedAt ?? null,
		})
		.returning()
	return { org, loc: loc!, sync: sync! }
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('GBP sweep & lifecycle hooks', () => {
	it('markGbpMenuDirty stamps menuDirtyAt on menu-sync-enabled locations', async () => {
		const { org, loc } = await seedLinkedLocation({
			menuSyncEnabled: true,
			menuDirtyAt: null,
		})
		await markGbpMenuDirty(org.id)
		const [row] = await db
			.select({ menuDirtyAt: GbpLocationSync.menuDirtyAt })
			.from(GbpLocationSync)
			.where(
				and(
					eq(GbpLocationSync.organizationId, org.id),
					eq(GbpLocationSync.organizationLocationId, loc.id),
				),
			)
		expect(row?.menuDirtyAt).toBeInstanceOf(Date)
	})

	it('onOrderingControlChangedGbp ignores short pauses (< 60m) and enqueues link push on long pauses and resume', async () => {
		const now = new Date('2026-04-12T12:00:00.000Z')
		const { org, loc } = await seedLinkedLocation({
			syncEnabled: true,
			orderingPausedAt: now,
			orderingPausedUntil: new Date(now.getTime() + 30 * 60 * 1000),
		})
		await enableFlag(org.id, 'gbp.sync')
		await enableFlag(org.id, 'gbp.write')

		// Short 30-minute pause -> must NOT enqueue Google push
		await onOrderingControlChangedGbp({
			organizationId: org.id,
			organizationLocationId: loc.id,
			intent: 'pause',
			now,
		})
		expect(mockEnqueueGbpPush).not.toHaveBeenCalled()

		// Long 3-hour pause -> enqueues links push
		await db
			.update(OrganizationLocation)
			.set({
				orderingPausedUntil: new Date(now.getTime() + 3 * 60 * 60 * 1000),
			})
			.where(eq(OrganizationLocation.id, loc.id))
		await onOrderingControlChangedGbp({
			organizationId: org.id,
			organizationLocationId: loc.id,
			intent: 'pause',
			now,
		})
		expect(mockEnqueueGbpPush).toHaveBeenCalledTimes(1)
		expect(mockEnqueueGbpPush).toHaveBeenLastCalledWith(
			expect.objectContaining({
				organizationId: org.id,
				organizationLocationId: loc.id,
				fields: ['links'],
			}),
		)

		// Resume -> restores order link
		await onOrderingControlChangedGbp({
			organizationId: org.id,
			organizationLocationId: loc.id,
			intent: 'resume',
			now,
		})
		expect(mockEnqueueGbpPush).toHaveBeenCalledTimes(2)
	})

	it('runHourlyGbpSweep retries pending pushes, pulls diffs, checks order links, and publishes dirty menus', async () => {
		const { org } = await seedLinkedLocation({
			pushRequestedAt: new Date(Date.now() - 5 * 60 * 1000),
			menuSyncEnabled: true,
			menuDirtyAt: new Date(Date.now() - 20 * 60 * 1000),
		})
		await enableFlag(org.id, 'gbp.sync')
		await enableFlag(org.id, 'gbp.write')

		const summary = await runHourlyGbpSweep({ organizationId: org.id })
		expect(summary.locations).toBe(1)
		expect(summary.pushed).toBe(1)
		expect(summary.pulled).toBe(1)
		expect(summary.orderLinksChecked).toBe(1)
		expect(summary.menusPublished).toBe(1)
		expect(mockPushLocationToGoogle).toHaveBeenCalledTimes(1)
		expect(mockPullLocation).toHaveBeenCalledTimes(1)
		expect(mockPublishMenu).toHaveBeenCalledTimes(1)
	})

	it('runDailyGbpMetricsSweep updates locations when fetchLocationMetrics returns backfilled/fetched', async () => {
		const { org } = await seedLinkedLocation({
			verificationState: 'verified',
			metricsBackfilledAt: null,
		})
		await enableFlag(org.id, 'gbp.sync')
		await enableFlag(org.id, 'gbp.insights')

		mockFetchLocationMetrics.mockResolvedValueOnce({ status: 'skipped' })
		const skipped = await runDailyGbpMetricsSweep({ organizationId: org.id })
		expect(skipped.skipped).toBe(1)
		expect(skipped.updated).toBe(0)

		mockFetchLocationMetrics.mockResolvedValueOnce({ status: 'backfilled' })
		const ran = await runDailyGbpMetricsSweep({ organizationId: org.id })
		expect(ran.updated).toBe(1)
		expect(ran.failed).toBe(0)
	})
})
