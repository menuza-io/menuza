import {
	and,
	db,
	eq,
	MenuSchedule,
	MenuSnapshot,
	OrganizationLocation,
	OrganizationMenu,
} from '@repo/database'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { server } from '#tests/mocks/index.ts'
import { createTestOrganization, createTestSession } from '#tests/test-utils.ts'
import {
	applyDueMenuSchedules,
	cancelMenuSchedule,
	claimDueMenuSchedule,
	handleMenuScheduleAction,
	listPendingMenuSchedules,
	parseScheduleGoLiveAt,
	runClaimedMenuSchedule,
	setMenuSchedule,
} from './menu-schedules.server.ts'

const snapshotStore = vi.hoisted(() => new Map<string, string>())

vi.mock('#app/utils/storage.server.ts', () => ({
	uploadMenuSnapshotJson: vi.fn(
		async (orgId: string, snapshotId: string, body: string) => {
			const key = `menu-snapshots/${orgId}/${snapshotId}.json`
			snapshotStore.set(key, body)
			return key
		},
	),
	readMenuSnapshotJson: vi.fn(async (contentKey: string) => {
		return snapshotStore.get(contentKey) ?? null
	}),
	deleteMenuSnapshotJson: vi.fn(async (contentKey: string) => {
		snapshotStore.delete(contentKey)
	}),
}))

vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return { ...actual, purgeOrganizationSiteCache: vi.fn(async () => true) }
})

const NOW = new Date('2026-12-01T10:00:00.000Z')
const FUTURE = new Date('2026-12-01T12:00:00.000Z')
const LATER = new Date('2026-12-01T14:00:00.000Z')

async function setupOrgWithMenus(
	role: 'admin' | 'member' | 'viewer' = 'admin',
) {
	const user = await insertTestUser()
	const org = await createTestOrganization(user.id, role)
	const [menuA] = await db
		.insert(OrganizationMenu)
		.values({
			organizationId: org.id,
			displayName: JSON.stringify({ en: 'Winter Menu' }),
			availabilityStatus: 'unavailable',
		})
		.returning()
	const [menuB] = await db
		.insert(OrganizationMenu)
		.values({
			organizationId: org.id,
			displayName: JSON.stringify({ en: 'Autumn Menu' }),
			availabilityStatus: 'available',
		})
		.returning()
	return { user, org, menuA: menuA!, menuB: menuB! }
}

beforeEach(async () => {
	snapshotStore.clear()
	vi.mocked(purgeOrganizationSiteCache).mockClear()
	await db.delete(MenuSchedule)
})

describe('menu-schedules.server (#149)', () => {
	it('refuses a past time with schedule_in_past and stores nothing', async () => {
		const { user, org, menuA } = await setupOrgWithMenus()
		const past = new Date(NOW.getTime() - 1_000)
		const result = await setMenuSchedule({
			organizationId: org.id,
			userId: user.id,
			menuId: menuA.id,
			goLiveAt: past,
			now: NOW,
		})
		expect(result).toEqual({ ok: false, error: 'schedule_in_past' })
		expect(await listPendingMenuSchedules(org.id)).toHaveLength(0)

		const equalNow = await setMenuSchedule({
			organizationId: org.id,
			userId: user.id,
			menuId: menuA.id,
			goLiveAt: NOW,
			now: NOW,
		})
		expect(equalNow).toEqual({ ok: false, error: 'schedule_in_past' })
	})

	it('converts local date and time in the organization timezone via localDateAndTimeToUtc', () => {
		// Asia/Riyadh is UTC+3 (no DST): 15:30 local -> 12:30 UTC
		const utc = parseScheduleGoLiveAt('2026-12-01', '15:30', 'Asia/Riyadh')
		expect(utc?.toISOString()).toBe('2026-12-01T12:30:00.000Z')
	})

	it('keeps at most one pending schedule per menu and replaces older pending schedules', async () => {
		const { user, org, menuA, menuB } = await setupOrgWithMenus()
		const first = await setMenuSchedule({
			organizationId: org.id,
			userId: user.id,
			menuId: menuA.id,
			goLiveAt: FUTURE,
			takeOffMenuId: menuB.id,
			now: NOW,
		})
		expect(first.ok).toBe(true)

		const second = await setMenuSchedule({
			organizationId: org.id,
			userId: user.id,
			menuId: menuA.id,
			goLiveAt: LATER,
			takeOffMenuId: null,
			now: NOW,
		})
		expect(second.ok).toBe(true)

		const pending = await listPendingMenuSchedules(org.id)
		expect(pending).toHaveLength(1)
		expect(pending[0]?.id).toBe(second.ok ? second.id : '')
		expect(pending[0]?.goLiveAt).toBe(LATER.toISOString())
		expect(pending[0]?.takeOffMenuId).toBeNull()

		if (first.ok) {
			const [oldRow] = await db
				.select()
				.from(MenuSchedule)
				.where(eq(MenuSchedule.id, first.id))
			expect(oldRow?.status).toBe('cancelled')
		}
	})

	it('applies due changeover swap, takes before_schedule snapshot, uses latest edited version, and purges cache', async () => {
		const { user, org, menuA, menuB } = await setupOrgWithMenus()
		const scheduled = await setMenuSchedule({
			organizationId: org.id,
			userId: user.id,
			menuId: menuA.id,
			goLiveAt: FUTURE,
			takeOffMenuId: menuB.id,
			now: NOW,
		})
		expect(scheduled.ok).toBe(true)

		// Edit menuA after scheduling: latest edited version must go live
		await db
			.update(OrganizationMenu)
			.set({ displayName: JSON.stringify({ en: 'Winter Menu v2' }) })
			.where(eq(OrganizationMenu.id, menuA.id))

		// Before due time: nothing runs
		const early = await applyDueMenuSchedules(new Date(FUTURE.getTime() - 1))
		expect(early).toEqual({ applied: 0, skipped: 0 })

		// At due time: swap happens
		const result = await applyDueMenuSchedules(FUTURE)
		expect(result).toEqual({ applied: 1, skipped: 0 })

		const [updatedA] = await db
			.select()
			.from(OrganizationMenu)
			.where(eq(OrganizationMenu.id, menuA.id))
		const [updatedB] = await db
			.select()
			.from(OrganizationMenu)
			.where(eq(OrganizationMenu.id, menuB.id))

		expect(updatedA?.availabilityStatus).toBe('available')
		expect(updatedA?.displayName).toBe(JSON.stringify({ en: 'Winter Menu v2' }))
		expect(updatedB?.availabilityStatus).toBe('unavailable')

		const snapshots = await db
			.select()
			.from(MenuSnapshot)
			.where(
				and(
					eq(MenuSnapshot.organizationId, org.id),
					eq(MenuSnapshot.reason, 'before_schedule'),
				),
			)
		expect(snapshots).toHaveLength(1)
		expect(purgeOrganizationSiteCache).toHaveBeenCalledWith(
			org.id,
			org.slug,
			org.customDomain,
		)
	})

	it('cancelled schedule does nothing when due', async () => {
		const { user, org, menuA, menuB } = await setupOrgWithMenus()
		await setMenuSchedule({
			organizationId: org.id,
			userId: user.id,
			menuId: menuA.id,
			goLiveAt: FUTURE,
			takeOffMenuId: menuB.id,
			now: NOW,
		})

		const cancelled = await cancelMenuSchedule({
			organizationId: org.id,
			menuId: menuA.id,
		})
		expect(cancelled).toBe(true)

		const result = await applyDueMenuSchedules(FUTURE)
		expect(result).toEqual({ applied: 0, skipped: 0 })

		const [afterA] = await db
			.select()
			.from(OrganizationMenu)
			.where(eq(OrganizationMenu.id, menuA.id))
		const [afterB] = await db
			.select()
			.from(OrganizationMenu)
			.where(eq(OrganizationMenu.id, menuB.id))
		expect(afterA?.availabilityStatus).toBe('unavailable')
		expect(afterB?.availabilityStatus).toBe('available')
		expect(purgeOrganizationSiteCache).not.toHaveBeenCalled()
	})

	it('claims atomically so concurrent double-run is a no-op', async () => {
		const { user, org, menuA, menuB } = await setupOrgWithMenus()
		const scheduled = await setMenuSchedule({
			organizationId: org.id,
			userId: user.id,
			menuId: menuA.id,
			goLiveAt: FUTURE,
			takeOffMenuId: menuB.id,
			now: NOW,
		})
		expect(scheduled.ok).toBe(true)
		if (!scheduled.ok) return

		const [firstClaim, secondClaim] = await Promise.all([
			claimDueMenuSchedule(scheduled.id, FUTURE),
			claimDueMenuSchedule(scheduled.id, FUTURE),
		])
		expect([firstClaim, secondClaim].filter(Boolean)).toHaveLength(1)

		const winner = firstClaim ?? secondClaim
		expect(winner).not.toBeNull()
		await runClaimedMenuSchedule(winner!, FUTURE)

		// Subsequent sweep does nothing
		const secondSweep = await applyDueMenuSchedules(FUTURE)
		expect(secondSweep).toEqual({ applied: 0, skipped: 0 })
	})

	it('enforces organization isolation across set, cancel, and apply', async () => {
		const ctxA = await setupOrgWithMenus()
		const ctxB = await setupOrgWithMenus()

		// Cannot schedule org A's menu under org B
		const crossMenu = await setMenuSchedule({
			organizationId: ctxB.org.id,
			userId: ctxB.user.id,
			menuId: ctxA.menuA.id,
			goLiveAt: FUTURE,
			now: NOW,
		})
		expect(crossMenu).toEqual({ ok: false, error: 'menu_not_found' })

		// Cannot take off org B's menu from org A's schedule
		const crossTakeOff = await setMenuSchedule({
			organizationId: ctxA.org.id,
			userId: ctxA.user.id,
			menuId: ctxA.menuA.id,
			goLiveAt: FUTURE,
			takeOffMenuId: ctxB.menuB.id,
			now: NOW,
		})
		expect(crossTakeOff).toEqual({
			ok: false,
			error: 'take_off_menu_not_found',
		})

		// Org A schedule cannot be cancelled by org B
		await setMenuSchedule({
			organizationId: ctxA.org.id,
			userId: ctxA.user.id,
			menuId: ctxA.menuA.id,
			goLiveAt: FUTURE,
			now: NOW,
		})
		expect(
			await cancelMenuSchedule({
				organizationId: ctxB.org.id,
				menuId: ctxA.menuA.id,
			}),
		).toBe(false)
		expect(await listPendingMenuSchedules(ctxA.org.id)).toHaveLength(1)
	})

	it('drops schedule when the target menu is deleted, and still brings menu live if takeOffMenu is deleted', async () => {
		const { user, org, menuA, menuB } = await setupOrgWithMenus()
		await setMenuSchedule({
			organizationId: org.id,
			userId: user.id,
			menuId: menuA.id,
			goLiveAt: FUTURE,
			takeOffMenuId: menuB.id,
			now: NOW,
		})

		// Deleting target menu cascades and drops the schedule
		await db.delete(OrganizationMenu).where(eq(OrganizationMenu.id, menuA.id))
		expect(await listPendingMenuSchedules(org.id)).toHaveLength(0)
		expect(await applyDueMenuSchedules(FUTURE)).toEqual({
			applied: 0,
			skipped: 0,
		})

		// Recreate menuA and schedule with menuB as takeOff; then delete menuB
		const [menuA2] = await db
			.insert(OrganizationMenu)
			.values({
				organizationId: org.id,
				displayName: JSON.stringify({ en: 'Spring Menu' }),
				availabilityStatus: 'unavailable',
			})
			.returning()
		await setMenuSchedule({
			organizationId: org.id,
			userId: user.id,
			menuId: menuA2!.id,
			goLiveAt: FUTURE,
			takeOffMenuId: menuB.id,
			now: NOW,
		})
		await db.delete(OrganizationMenu).where(eq(OrganizationMenu.id, menuB.id))

		const res = await applyDueMenuSchedules(FUTURE)
		expect(res).toEqual({ applied: 1, skipped: 0 })
		const [updatedA2] = await db
			.select()
			.from(OrganizationMenu)
			.where(eq(OrganizationMenu.id, menuA2!.id))
		expect(updatedA2?.availabilityStatus).toBe('available')
	})

	it('handleMenuScheduleAction requires update:menu:any and uses org location timezone', async () => {
		const viewerCtx = await setupOrgWithMenus('viewer')
		const adminCtx = await setupOrgWithMenus('admin')

		await db.insert(OrganizationLocation).values({
			organizationId: adminCtx.org.id,
			name: 'Riyadh',
			slug: 'riyadh',
			isDefault: true,
			timezone: 'Asia/Riyadh',
		})

		const { cookieHeader: viewerCookie } = await createTestSession(
			viewerCtx.user.id,
		)
		const viewerForm = new FormData()
		viewerForm.set('intent', 'schedule-menu')
		viewerForm.set('goLiveDate', '2099-01-01')
		viewerForm.set('goLiveTime', '12:00')

		let viewerStatus = 0
		try {
			const res = await handleMenuScheduleAction({
				request: new Request('http://localhost/test', {
					method: 'POST',
					headers: { cookie: viewerCookie },
				}),
				organizationId: viewerCtx.org.id,
				menuId: viewerCtx.menuA.id,
				formData: viewerForm,
			})
			viewerStatus = res.status
		} catch (err) {
			viewerStatus = err instanceof Response ? err.status : 500
		}
		expect(viewerStatus).toBe(403)

		// Admin can schedule and cancel; past time returns 400 schedule_in_past
		const { cookieHeader: adminCookie } = await createTestSession(
			adminCtx.user.id,
		)
		const pastForm = new FormData()
		pastForm.set('intent', 'schedule-menu')
		pastForm.set('goLiveDate', '2020-01-01')
		pastForm.set('goLiveTime', '12:00')
		const pastRes = await handleMenuScheduleAction({
			request: new Request('http://localhost/test', {
				method: 'POST',
				headers: { cookie: adminCookie },
			}),
			organizationId: adminCtx.org.id,
			menuId: adminCtx.menuA.id,
			formData: pastForm,
		})
		expect(pastRes.status).toBe(400)
		expect(await pastRes.json()).toEqual({
			ok: false,
			error: 'schedule_in_past',
		})

		const wakeBodies: unknown[] = []
		server.use(
			http.post(
				'http://localhost:8787/workflows/menu-schedule/start',
				async ({ request }) => {
					wakeBodies.push(await request.json())
					return HttpResponse.json({ success: true, instanceId: 'inst_1' })
				},
			),
		)

		const futureForm = new FormData()
		futureForm.set('intent', 'schedule-menu')
		futureForm.set('goLiveDate', '2026-12-25')
		futureForm.set('goLiveTime', '15:00')
		futureForm.set('takeOffMenuId', adminCtx.menuB.id)
		const okRes = await handleMenuScheduleAction({
			request: new Request('http://localhost/test', {
				method: 'POST',
				headers: { cookie: adminCookie },
			}),
			organizationId: adminCtx.org.id,
			menuId: adminCtx.menuA.id,
			formData: futureForm,
		})
		expect(okRes.status).toBe(200)
		const okBody = (await okRes.json()) as {
			ok: boolean
			schedule: { goLiveAt: string; takeOffMenuId: string | null }
		}
		expect(okBody.ok).toBe(true)
		expect(okBody.schedule.goLiveAt).toBe('2026-12-25T12:00:00.000Z')
		expect(okBody.schedule.takeOffMenuId).toBe(adminCtx.menuB.id)
		expect(wakeBodies).toEqual([
			{
				scheduleId: expect.any(String),
				runAt: '2026-12-25T12:00:00.000Z',
			},
		])
	})
})
