import { AuditAction, auditService } from '@repo/audit'
import {
	db,
	eq,
	OrganizationLocation,
	OrganizationLocationSettingPolicy,
	UserOrganization,
} from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commitLocationPatches } from '#app/utils/location/location-settings.server.ts'
import { applyOrderingControl } from '#app/utils/location/ordering-controls.server.ts'
import type * as OrderingControls from '#app/utils/location/ordering-controls.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './locations._index.tsx'

// The site cache and the regional notify are the external boundaries.
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(true),
}))
vi.mock('#app/utils/reservations/access.server.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	notifyReservationsContextChanged: vi.fn().mockResolvedValue(undefined),
}))
vi.mock(
	'#app/utils/location/ordering-controls.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof OrderingControls>()
		return {
			...actual,
			applyOrderingControl: vi.fn(actual.applyOrderingControl),
		}
	},
)

const week = (open: string, close: string) =>
	JSON.stringify(
		['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((day) => ({
			day,
			isOpen: true,
			slots: [{ start: open, end: close }],
		})),
	)

async function createLocation(
	organizationId: string,
	values: Partial<typeof OrganizationLocation.$inferInsert> = {},
) {
	const slug = `loc-${crypto.randomUUID().slice(0, 8)}`
	const [row] = await db
		.insert(OrganizationLocation)
		.values({ organizationId, name: `Loc ${slug}`, slug, ...values })
		.returning()
	return row!
}

async function read(id: string) {
	const [row] = await db
		.select()
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.id, id))
	return row!
}

function post(
	orgSlug: string,
	cookie: string,
	intent: string,
	payload: unknown,
) {
	const body = new FormData()
	body.set('intent', intent)
	body.set('payload', JSON.stringify(payload))
	const request = createAuthenticatedRequest(
		`https://app.test/${orgSlug}/settings/locations`,
		{ method: 'POST', body },
		cookie,
	)
	return action({ request, params: { orgSlug }, context: {} } as never)
}

async function json(result: unknown) {
	const response = result as { data?: unknown; init?: unknown }
	return (response.data ?? result) as Record<string, any>
}

async function scopedMember(
	organizationId: string,
	locationIds: string[],
	roleId = 'org_role_admin',
) {
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, roleId)
	await setMemberLocationScope({
		organizationId,
		userId: user.id,
		value: { scope: 'selected', locationIds },
	})
	const { cookie } = await createTestSession(user.id)
	return { user, cookie }
}

describe('copy settings (#125)', () => {
	beforeEach(() => {
		vi.mocked(purgeOrganizationSiteCache).mockClear()
	})

	it('copies online hours from A to B and C and changes only online hours there', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, {
			onlineHours: week('11:00', '22:00'),
			storeHours: week('09:00', '17:00'),
			prepTime: 40,
		})
		const b = await createLocation(organization.id, {
			onlineHours: week('08:00', '12:00'),
			storeHours: week('07:00', '19:00'),
			prepTime: 10,
		})
		const c = await createLocation(organization.id, {
			onlineHours: null,
			prepTime: 20,
			timezone: 'America/Los_Angeles',
		})
		const beforeB = await read(b.id)
		const beforeC = await read(c.id)

		const result = await post(organization.slug, cookie, 'copy-settings', {
			sourceId: a.id,
			targetIds: [b.id, c.id],
			parts: ['onlineHours'],
		})
		const body = await json(result)
		expect(body.ok).toBe(true)
		expect(body.copy.changedLocationIds.sort()).toEqual([b.id, c.id].sort())

		const afterB = await read(b.id)
		const afterC = await read(c.id)
		expect(JSON.parse(afterB.onlineHours!)).toEqual(JSON.parse(a.onlineHours!))
		expect(JSON.parse(afterC.onlineHours!)).toEqual(JSON.parse(a.onlineHours!))
		// Everything else is byte for byte what it was.
		for (const [before, after] of [
			[beforeB, afterB],
			[beforeC, afterC],
		] as const) {
			const {
				onlineHours: ignoredBefore,
				updatedAt: ignoredTime,
				...restBefore
			} = before
			const {
				onlineHours: ignoredAfter,
				updatedAt: ignoredTime2,
				...restAfter
			} = after
			expect(ignoredBefore).not.toBe(ignoredAfter)
			expect(restAfter).toEqual(restBefore)
			expect(ignoredTime && ignoredTime2).toBeTruthy()
		}
		// The source is untouched.
		expect(await read(a.id)).toMatchObject({ prepTime: 40 })
		// The preview states the time zone of C.
		const previewC = body.copy.targets.find((t: any) => t.targetId === c.id)
		expect(previewC.changes[0].notes).toContain('timezone_differs')
	})

	it('a preview writes nothing and shows the same changes the copy then makes', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 35 })
		const b = await createLocation(organization.id, { prepTime: 10 })
		const preview = await json(
			await post(organization.slug, cookie, 'preview-copy', {
				sourceId: a.id,
				targetIds: [b.id],
				parts: ['prepTime'],
			}),
		)
		expect(preview.copy.applied).toBe(false)
		expect(preview.copy.targets[0].changes[0]).toMatchObject({
			part: 'prepTime',
			before: '10 min',
			after: '35 min',
			changed: true,
		})
		expect((await read(b.id)).prepTime).toBe(10)
		expect(purgeOrganizationSiteCache).not.toHaveBeenCalled()

		const applied = await json(
			await post(organization.slug, cookie, 'copy-settings', {
				sourceId: a.id,
				targetIds: [b.id],
				parts: ['prepTime'],
			}),
		)
		expect(applied.copy.targets).toEqual(preview.copy.targets)
		expect((await read(b.id)).prepTime).toBe(35)
	})

	it('purges the Sites cache after a copy so the new hours show at once, and not when nothing changed', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, {
			onlineHours: week('10:00', '20:00'),
		})
		const b = await createLocation(organization.id)
		await post(organization.slug, cookie, 'copy-settings', {
			sourceId: a.id,
			targetIds: [b.id],
			parts: ['onlineHours'],
		})
		expect(purgeOrganizationSiteCache).toHaveBeenCalledTimes(1)
		expect(purgeOrganizationSiteCache).toHaveBeenCalledWith(
			organization.id,
			organization.slug,
		)
		vi.mocked(purgeOrganizationSiteCache).mockClear()
		await post(organization.slug, cookie, 'copy-settings', {
			sourceId: a.id,
			targetIds: [b.id],
			parts: ['onlineHours'],
		})
		expect(purgeOrganizationSiteCache).not.toHaveBeenCalled()
	})

	it('writes one activity log entry per setting changed per target, with the source', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, {
			prepTime: 35,
			onlineHours: week('10:00', '20:00'),
		})
		const b = await createLocation(organization.id, { prepTime: 10 })
		const c = await createLocation(organization.id, {
			prepTime: 35,
			onlineHours: week('10:00', '20:00'),
		})
		const log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await post(organization.slug, cookie, 'copy-settings', {
			sourceId: a.id,
			targetIds: [b.id, c.id],
			parts: ['prepTime', 'onlineHours'],
		})
		const entries = log.mock.calls
			.map(([input]) => input)
			.filter((input) => input.action === AuditAction.LOCATION_SETTING_COPIED)
		// B changes both settings, C already matches both: two entries, all on B.
		expect(entries).toHaveLength(2)
		expect(entries.map((e) => e.resourceId)).toEqual([b.id, b.id])
		expect(entries.map((e) => (e.metadata as any).setting).sort()).toEqual([
			'onlineHours',
			'prepTime',
		])
		expect(entries[0]!.metadata).toMatchObject({ sourceLocationId: a.id })
		log.mockRestore()
	})

	it('adds a holiday to every chosen location and skips one that already has the date', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		const b = await createLocation(organization.id, {
			specialHours: JSON.stringify([
				{
					id: 'x',
					date: '2027-12-25',
					isOpen: true,
					slots: [{ start: '10:00', end: '14:00' }],
				},
			]),
		})
		const c = await createLocation(organization.id, {
			specialHours: JSON.stringify([
				{ id: 'y', date: '2027-01-01', isOpen: false, slots: [] },
			]),
		})
		const body = await json(
			await post(organization.slug, cookie, 'add-holiday', {
				targetIds: [a.id, b.id, c.id],
				date: '2027-12-25',
				isOpen: false,
				slots: [],
				note: 'Christmas',
			}),
		)
		expect(body.ok).toBe(true)
		expect(body.holiday.added.map((l: any) => l.locationId).sort()).toEqual(
			[a.id, c.id].sort(),
		)
		expect(body.holiday.alreadyHadDate.map((l: any) => l.locationId)).toEqual([
			b.id,
		])

		const entries = async (id: string) =>
			JSON.parse((await read(id)).specialHours!) as Array<{
				date: string
				isOpen: boolean
			}>
		expect(
			(await entries(a.id)).filter((e) => e.date === '2027-12-25'),
		).toHaveLength(1)
		expect((await entries(c.id)).map((e) => e.date)).toEqual([
			'2027-01-01',
			'2027-12-25',
		])
		// B keeps its own open entry for that date, untouched.
		const bEntries = await entries(b.id)
		expect(bEntries).toHaveLength(1)
		expect(bEntries[0]).toMatchObject({ date: '2027-12-25', isOpen: true })
	})

	it('a location-scoped member cannot target a location outside their scope (skipped and listed, never written)', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 40 })
		const b = await createLocation(organization.id, { prepTime: 10 })
		const c = await createLocation(organization.id, { prepTime: 10 })
		const { cookie } = await scopedMember(organization.id, [a.id, b.id])

		const body = await json(
			await post(organization.slug, cookie, 'copy-settings', {
				sourceId: a.id,
				targetIds: [b.id, c.id],
				parts: ['prepTime'],
			}),
		)
		expect(body.ok).toBe(true)
		expect(body.copy.changedLocationIds).toEqual([b.id])
		expect(body.copy.skipped).toEqual([
			expect.objectContaining({ locationId: c.id, reason: 'not_manageable' }),
		])
		expect((await read(b.id)).prepTime).toBe(40)
		expect((await read(c.id)).prepTime).toBe(10)

		// A source outside the scope is refused outright.
		const refusedResult = await post(
			organization.slug,
			cookie,
			'copy-settings',
			{
				sourceId: c.id,
				targetIds: [b.id],
				parts: ['prepTime'],
			},
		)
		expect(getResponseStatus(refusedResult)).toBe(403)
		expect((await json(refusedResult)).error).toBe('location_not_allowed')

		// The same holds for the holiday shortcut.
		const holiday = await json(
			await post(organization.slug, cookie, 'add-holiday', {
				targetIds: [b.id, c.id],
				date: '2027-12-25',
				isOpen: false,
				slots: [],
			}),
		)
		expect(holiday.holiday.added.map((l: any) => l.locationId)).toEqual([b.id])
		expect(holiday.holiday.skipped).toEqual([
			expect.objectContaining({ locationId: c.id, reason: 'not_manageable' }),
		])
		expect((await read(c.id)).specialHours).toBeNull()
	})

	it('refuses ids of another organization and a member without settings access', async () => {
		const mine = await setupTestOrgWithUser('admin')
		const other = await setupTestOrgWithUser('admin')
		const a = await createLocation(mine.organization.id, { prepTime: 40 })
		const theirs = await createLocation(other.organization.id, { prepTime: 10 })

		const body = await json(
			await post(mine.organization.slug, mine.cookie, 'copy-settings', {
				sourceId: a.id,
				targetIds: [theirs.id],
				parts: ['prepTime'],
			}),
		)
		expect(body.copy.changedLocationIds).toEqual([])
		expect(body.copy.skipped).toEqual([
			expect.objectContaining({ locationId: theirs.id, reason: 'not_found' }),
		])
		expect((await read(theirs.id)).prepTime).toBe(10)

		// A source from another organization does not exist for this one.
		const foreignSource = await post(
			mine.organization.slug,
			mine.cookie,
			'copy-settings',
			{
				sourceId: theirs.id,
				targetIds: [a.id],
				parts: ['prepTime'],
			},
		)
		expect(getResponseStatus(foreignSource)).toBe(404)

		const viewer = await setupTestOrgWithUser('viewer')
		const denied = await post(
			viewer.organization.slug,
			viewer.cookie,
			'copy-settings',
			{
				sourceId: a.id,
				targetIds: [theirs.id],
				parts: ['prepTime'],
			},
		).catch((error: Response) => error)
		expect(denied).toBeInstanceOf(Response)
		expect((denied as Response).status).toBe(403)
	})

	it('rejects a malformed or oversized request', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		for (const payload of [
			{},
			{ sourceId: 'a', targetIds: [], parts: ['prepTime'] },
			{ sourceId: 'a', targetIds: ['b'], parts: ['nope'] },
			{ sourceId: 'a', targetIds: ['b'], parts: [] },
		]) {
			expect(
				getResponseStatus(
					await post(organization.slug, cookie, 'copy-settings', payload),
				),
			).toBe(400)
		}
	})

	it('refuses to copy a locked setting (409) and writes nothing', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 40 })
		const b = await createLocation(organization.id, { prepTime: 10 })
		await db.insert(OrganizationLocationSettingPolicy).values({
			organizationId: organization.id,
			settingId: 'prepTime',
			defaultValue: '15',
			locked: true,
			lockReason: 'Chain rule',
		})
		const result = await post(organization.slug, cookie, 'copy-settings', {
			sourceId: a.id,
			targetIds: [b.id],
			parts: ['prepTime', 'onlineHours'],
		})
		expect(getResponseStatus(result)).toBe(409)
		expect(await json(result)).toMatchObject({
			error: 'setting_locked',
			settings: ['prepTime'],
		})
		expect((await read(b.id)).prepTime).toBe(10)
	})

	it('changes every target or none: a failing statement in the batch rolls back the others', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 10 })
		const b = await createLocation(organization.id, { prepTime: 10 })
		await expect(
			commitLocationPatches(organization.id, [
				{ locationId: a.id, patch: { prepTime: 99 } },
				// prepTime is NOT NULL: this statement fails, so the first must not stick.
				{ locationId: b.id, patch: { prepTime: null as unknown as number } },
			]),
		).rejects.toBeTruthy()
		expect((await read(a.id)).prepTime).toBe(10)
		expect((await read(b.id)).prepTime).toBe(10)
	})

	it('a statement never writes a location of another organization', async () => {
		const mine = await setupTestOrgWithUser('admin')
		const other = await setupTestOrgWithUser('admin')
		const theirs = await createLocation(other.organization.id, { prepTime: 10 })
		await commitLocationPatches(mine.organization.id, [
			{ locationId: theirs.id, patch: { prepTime: 99 } },
		])
		expect((await read(theirs.id)).prepTime).toBe(10)
	})
})

describe('bulk pause and resume (#365)', () => {
	beforeEach(() => {
		vi.mocked(purgeOrganizationSiteCache).mockClear()
	})
	afterEach(() => {
		vi.mocked(applyOrderingControl).mockClear()
	})

	async function tenLocations(organizationId: string) {
		const rows = []
		for (let i = 0; i < 10; i++) rows.push(await createLocation(organizationId))
		return rows
	}

	it('pausing 10 locations in one action pauses every one the person may manage', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const rows = await tenLocations(organization.id)
		const result = await json(
			await post(organization.slug, cookie, 'bulk-ordering', {
				action: 'pause',
				locationIds: rows.map((row) => row.id),
				duration: '60m',
				reason: 'Supplier delay',
			}),
		)
		expect(result.bulk).toMatchObject({
			action: 'pause',
			total: 10,
			done: 10,
			skipped: 0,
			failed: 0,
		})
		for (const row of rows) {
			const after = await read(row.id)
			expect(after.orderingPausedAt).not.toBeNull()
			expect(after.orderingPausedUntil).not.toBeNull()
		}
		// One cache purge for the whole action.
		expect(purgeOrganizationSiteCache).toHaveBeenCalledTimes(1)
	})

	it('records every pause in the activity log with who, the reason and the end time', async () => {
		const { organization, cookie, user } = await setupTestOrgWithUser('admin')
		const rows = await tenLocations(organization.id)
		const log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await post(organization.slug, cookie, 'bulk-ordering', {
			action: 'pause',
			locationIds: rows.map((row) => row.id),
			duration: '30m',
			reason: 'Supplier delay',
		})
		const entries = log.mock.calls
			.map(([input]) => input)
			.filter((input) => input.action === AuditAction.LOCATION_ORDERING_PAUSED)
		expect(entries.map((entry) => entry.resourceId).sort()).toEqual(
			rows.map((row) => row.id).sort(),
		)
		for (const entry of entries) {
			expect(entry.userId).toBe(user.id)
			expect(entry.organizationId).toBe(organization.id)
			expect(entry.metadata).toMatchObject({
				reason: 'Supplier delay',
				bulkSize: 10,
			})
			expect((entry.metadata as any).until).toBeTruthy()
		}
		log.mockRestore()
	})

	it('a failure on one location does not stop the rest and is listed as failed', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const rows = await tenLocations(organization.id)
		const poisoned = rows[3]!.id
		// The action logs the failed location by id; that log is expected here.
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
		const real = (
			await vi.importActual<typeof OrderingControls>(
				'#app/utils/location/ordering-controls.server.ts',
			)
		).applyOrderingControl
		vi.mocked(applyOrderingControl).mockImplementation(async (input) => {
			if (input.control.locationId === poisoned) throw new Error('boom')
			return real(input)
		})
		const result = await json(
			await post(organization.slug, cookie, 'bulk-ordering', {
				action: 'pause',
				locationIds: rows.map((row) => row.id),
				duration: 'until_resumed',
			}),
		)
		expect(result.bulk).toMatchObject({
			total: 10,
			done: 9,
			failed: 1,
			skipped: 0,
		})
		expect(result.bulk.locations[3]).toMatchObject({
			locationId: poisoned,
			status: 'failed',
			reason: 'failed',
		})
		expect((await read(poisoned)).orderingPausedAt).toBeNull()
		for (const row of rows.filter((r) => r.id !== poisoned)) {
			expect((await read(row.id)).orderingPausedAt).not.toBeNull()
		}
		expect(logged).toHaveBeenCalledWith(
			'bulk ordering control failed for a location',
			expect.objectContaining({ locationId: poisoned }),
		)
		logged.mockRestore()
		vi.mocked(applyOrderingControl).mockImplementation(real)
	})

	it('skips locations outside the scope or the organization and lists them', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const other = await setupTestOrgWithUser('admin')
		const rows = await tenLocations(organization.id)
		const foreign = await createLocation(other.organization.id)
		const mine = rows.slice(0, 4).map((row) => row.id)
		const { cookie } = await scopedMember(organization.id, mine)

		const result = await json(
			await post(organization.slug, cookie, 'bulk-ordering', {
				action: 'pause',
				locationIds: [...rows.map((row) => row.id), foreign.id],
				duration: '15m',
			}),
		)
		expect(result.bulk).toMatchObject({
			total: 11,
			done: 4,
			skipped: 7,
			failed: 0,
		})
		const skipped = result.bulk.locations.filter(
			(l: any) => l.status === 'skipped',
		)
		expect(
			skipped.filter((l: any) => l.reason === 'not_manageable'),
		).toHaveLength(6)
		expect(skipped.find((l: any) => l.locationId === foreign.id)).toMatchObject(
			{
				reason: 'not_found',
			},
		)
		for (const row of rows.slice(4)) {
			expect((await read(row.id)).orderingPausedAt).toBeNull()
		}
		expect((await read(foreign.id)).orderingPausedAt).toBeNull()
	})

	it('resumes many locations and reports the count', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const rows = await tenLocations(organization.id)
		const ids = rows.map((row) => row.id)
		await post(organization.slug, cookie, 'bulk-ordering', {
			action: 'pause',
			locationIds: ids,
			duration: 'until_resumed',
		})
		const result = await json(
			await post(organization.slug, cookie, 'bulk-ordering', {
				action: 'resume',
				locationIds: ids.slice(0, 3),
			}),
		)
		expect(result.bulk).toMatchObject({ action: 'resume', total: 3, done: 3 })
		expect((await read(ids[0]!)).orderingPausedAt).toBeNull()
		expect((await read(ids[5]!)).orderingPausedAt).not.toBeNull()
	})

	it('needs menu write access like the Orders page, and rejects a malformed request', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect(
			getResponseStatus(
				await post(organization.slug, cookie, 'bulk-ordering', {
					action: 'pause',
					locationIds: [],
					duration: '15m',
				}),
			),
		).toBe(400)
		expect(
			getResponseStatus(
				await post(organization.slug, cookie, 'bulk-ordering', {
					action: 'pause',
					locationIds: ['a'],
					duration: 'forever',
				}),
			),
		).toBe(400)

		const viewer = await setupTestOrgWithUser('viewer')
		const denied = await post(
			viewer.organization.slug,
			viewer.cookie,
			'bulk-ordering',
			{
				action: 'pause',
				locationIds: ['a'],
				duration: '15m',
			},
		).catch((error: Response) => error)
		expect(denied).toBeInstanceOf(Response)
		expect((denied as Response).status).toBe(403)
	})

	it('the single-location Orders route also refuses a location outside the scope', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const inside = await createLocation(organization.id)
		const outside = await createLocation(organization.id)
		const { cookie } = await scopedMember(organization.id, [inside.id])
		const { action: ordersAction } =
			await import('../orders_.ordering-controls.ts')
		const send = (locationId: string) =>
			ordersAction({
				request: createAuthenticatedRequest(
					`https://app.test/${organization.slug}/orders/ordering-controls`,
					{
						method: 'POST',
						body: new URLSearchParams({
							intent: 'pause',
							locationId,
							duration: '15m',
						}),
					},
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as never)
		expect(getResponseStatus(await send(outside.id))).toBe(403)
		expect((await read(outside.id)).orderingPausedAt).toBeNull()
		expect(getResponseStatus(await send(inside.id))).toBe(200)
		expect((await read(inside.id)).orderingPausedAt).not.toBeNull()
	})
})

describe('member scope sanity', () => {
	it('keeps the member row scope in sync with the resolver (selected members are never "all")', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const { user } = await scopedMember(organization.id, [])
		const [row] = await db
			.select({ scope: UserOrganization.locationScope })
			.from(UserOrganization)
			.where(eq(UserOrganization.userId, user.id))
		expect(row?.scope).toBe('selected')
	})
})
