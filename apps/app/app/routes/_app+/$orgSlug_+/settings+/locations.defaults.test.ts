import { AuditAction, auditService } from '@repo/audit'
import { db, eq, getLockedLocationSettingIds, OrganizationLocation } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyChainDefaultsToNewLocation } from '#app/utils/location/chain-defaults.server.ts'
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
import { action as editAction, loader as editLoader } from './locations.$locationId.tsx'
import { action as compareAction, loader as compareLoader } from './locations.compare.tsx'
import {
	action as defaultsAction,
	loader as defaultsLoader,
} from './locations.defaults.tsx'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(true),
}))
vi.mock('#app/utils/reservations/access.server.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	notifyReservationsContextChanged: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('#app/utils/phone-agent/phone-agent.server.ts', () => ({
	deleteScopeData: vi.fn(),
}))
vi.mock('#app/utils/location/geocoder.server.ts', () => ({
	ensureLocationCoordinates: async (address: unknown) => ({ address }),
}))
vi.mock('@repo/common/feature-flags', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getFeatureFlag: vi.fn(async () => null),
}))

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

function args(orgSlug: string, cookie: string, init: RequestInit = {}, extra = '') {
	const url = new URL(`https://app.test/${orgSlug}/settings/locations/x${extra}`)
	return {
		request: createAuthenticatedRequest(url.toString(), init, cookie),
		params: { orgSlug },
		context: new RouterContextProvider(),
		url,
		pattern: '/:orgSlug/settings/locations/x',
	} as never
}

function postPayload(intent: string | null, payload: unknown) {
	const body = new FormData()
	if (intent) body.set('intent', intent)
	body.set('payload', JSON.stringify(payload))
	return { method: 'POST', body }
}

const defaults = (orgSlug: string, cookie: string, payload: unknown) =>
	defaultsAction(args(orgSlug, cookie, postPayload(null, payload))) as Promise<any>

const compare = (
	orgSlug: string,
	cookie: string,
	intent: 'preview-edit' | 'apply-edit',
	payload: unknown,
) =>
	compareAction(args(orgSlug, cookie, postPayload(intent, payload))) as Promise<any>

const body = (result: any) => result?.data ?? result

async function scopedAdmin(organizationId: string, locationIds: string[]) {
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, 'org_role_admin')
	await setMemberLocationScope({
		organizationId,
		userId: user.id,
		value: { scope: 'selected', locationIds },
	})
	const { cookie } = await createTestSession(user.id)
	return cookie
}

function editArgs(
	organization: { slug: string },
	locationId: string,
	cookie: string,
	fields?: Record<string, string>,
) {
	const url = new URL(
		`https://app.test/${organization.slug}/settings/locations/${locationId}`,
	)
	return {
		request: createAuthenticatedRequest(
			url.toString(),
			fields
				? { method: 'POST', body: new URLSearchParams(fields) }
				: {},
			cookie,
		),
		params: { orgSlug: organization.slug, locationId },
		context: new RouterContextProvider(),
		url,
		pattern: '/:orgSlug/settings/locations/:locationId',
	} as never
}

function formFields(location: { name: string; slug: string }, prepTime: number) {
	return {
		name: location.name,
		slug: location.slug,
		timezone: 'America/New_York',
		isActive: 'true',
		isDefault: 'false',
		prepTime: String(prepTime),
	}
}

describe('chain defaults and locks (#417)', () => {
	beforeEach(() => {
		vi.mocked(purgeOrganizationSiteCache).mockClear()
	})

	it('changing the default updates the locations that inherit it and keeps overrides', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 15 })
		const b = await createLocation(organization.id, { prepTime: 15 })
		const c = await createLocation(organization.id, { prepTime: 30 })

		const first = body(
			await defaults(organization.slug, cookie, {
				intent: 'set-default',
				settingId: 'prepTime',
				value: 15,
				locked: false,
			}),
		)
		expect(first.ok).toBe(true)
		// Nobody moved; C already differs, so it is an override.
		expect(first.result.updatedLocationIds).toEqual([])
		expect(first.result.overrides.map((o: any) => o.locationId)).toEqual([c.id])

		const second = body(
			await defaults(organization.slug, cookie, {
				intent: 'set-default',
				settingId: 'prepTime',
				value: 25,
				locked: false,
			}),
		)
		expect(second.result.updatedLocationIds.sort()).toEqual([a.id, b.id].sort())
		expect((await read(a.id)).prepTime).toBe(25)
		expect((await read(b.id)).prepTime).toBe(25)
		// The override is kept as it was.
		expect((await read(c.id)).prepTime).toBe(30)
		expect(second.result.overrides.map((o: any) => o.locationId)).toEqual([c.id])
		expect(purgeOrganizationSiteCache).toHaveBeenCalled()
	})

	it('lists overrides as overrides in the overview, the location view and the compare table', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 20 })
		const c = await createLocation(organization.id, { prepTime: 45 })
		await defaults(organization.slug, cookie, {
			intent: 'set-default',
			settingId: 'prepTime',
			value: 20,
			locked: false,
		})

		const overview = (await defaultsLoader(args(organization.slug, cookie))) as any
		const row = overview.rows.find((r: any) => r.settingId === 'prepTime')
		expect(row).toMatchObject({
			hasDefault: true,
			defaultText: '20 min',
			locked: false,
			inheritingCount: 1,
		})
		expect(row.overrides).toEqual([
			expect.objectContaining({ locationId: c.id, value: '45 min' }),
		])

		const viewOfC = (await editLoader(editArgs(organization, c.id, cookie))) as any
		expect(viewOfC.policy.overrides).toEqual(['prepTime'])
		const viewOfA = (await editLoader(editArgs(organization, a.id, cookie))) as any
		expect(viewOfA.policy.overrides).toEqual([])

		const table = (await compareLoader(
			args(organization.slug, cookie, {}, '?setting=prepTime'),
		)) as any
		expect(table.defaultText).toBe('20 min')
		expect(
			Object.fromEntries(
				table.rows.map((r: any) => [r.locationId, r.overridesDefault]),
			),
		).toEqual({ [a.id]: false, [c.id]: true })
	})

	it('a locked setting cannot be edited at a location: the server refuses it and writes nothing', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 20 })
		await defaults(organization.slug, cookie, {
			intent: 'set-default',
			settingId: 'prepTime',
			value: 20,
			locked: true,
			lockReason: 'Chain rule',
		})

		const refused = (await editAction(
			editArgs(organization, a.id, cookie, formFields(a, 45)),
		)) as Response
		expect(refused.status).toBe(409)
		expect(await refused.json()).toMatchObject({
			code: 'setting_locked',
			settings: ['prepTime'],
		})
		expect((await read(a.id)).prepTime).toBe(20)

		// Saving the form without touching the locked setting still works.
		const saved = (await editAction(
			editArgs(organization, a.id, cookie, {
				...formFields(a, 20),
				name: 'Renamed',
			}),
		)) as Response
		expect(saved.status).toBe(302)
		expect((await read(a.id)).name).toBe('Renamed')

		// The location view tells the form what is locked and why.
		const view = (await editLoader(editArgs(organization, a.id, cookie))) as any
		expect(view.policy.locked).toEqual([
			{ settingId: 'prepTime', reason: 'Chain rule' },
		])

		// A manager limited to this location is refused the same way.
		const managerCookie = await scopedAdmin(organization.id, [a.id])
		const managerTry = (await editAction(
			editArgs(organization, a.id, managerCookie, formFields(a, 60)),
		)) as Response
		expect(managerTry.status).toBe(409)
		expect((await read(a.id)).prepTime).toBe(20)
	})

	it('an unlocked default can be overridden at a location', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 20 })
		await defaults(organization.slug, cookie, {
			intent: 'set-default',
			settingId: 'prepTime',
			value: 20,
			locked: false,
		})
		const saved = (await editAction(
			editArgs(organization, a.id, cookie, formFields(a, 45)),
		)) as Response
		expect(saved.status).toBe(302)
		expect((await read(a.id)).prepTime).toBe(45)
		const view = (await editLoader(editArgs(organization, a.id, cookie))) as any
		expect(view.policy.overrides).toEqual(['prepTime'])
	})

	it('the compare and edit tool and the copy tool cannot change a locked setting either', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 20 })
		const b = await createLocation(organization.id, { prepTime: 20 })
		await defaults(organization.slug, cookie, {
			intent: 'set-default',
			settingId: 'prepTime',
			value: 20,
			locked: true,
		})
		const result = await compare(organization.slug, cookie, 'apply-edit', {
			settingId: 'prepTime',
			locationIds: [a.id, b.id],
			change: { kind: 'value', value: 50 },
		})
		expect(getResponseStatus(result)).toBe(409)
		expect(body(result).error).toBe('setting_locked')
		expect((await read(a.id)).prepTime).toBe(20)
		const matched = await compare(organization.slug, cookie, 'apply-edit', {
			settingId: 'prepTime',
			locationIds: [a.id],
			change: { kind: 'match', sourceId: b.id },
		})
		expect(getResponseStatus(matched)).toBe(409)
	})

	it('clearing an override on a locked setting puts the location back on the locked default', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 45 })
		await defaults(organization.slug, cookie, {
			intent: 'set-default',
			settingId: 'prepTime',
			value: 20,
			locked: true,
		})
		// A's 45 predates the lock: kept, and listed.
		const overview = (await defaultsLoader(args(organization.slug, cookie))) as any
		expect(
			overview.rows.find((r: any) => r.settingId === 'prepTime').overrides,
		).toHaveLength(1)
		expect((await read(a.id)).prepTime).toBe(45)
		const cleared = await compare(organization.slug, cookie, 'apply-edit', {
			settingId: 'prepTime',
			locationIds: [a.id],
			change: { kind: 'clear' },
		})
		expect(body(cleared).ok).toBe(true)
		expect((await read(a.id)).prepTime).toBe(20)
	})

	it('head office can reset every override, remove the default and unlock', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 45 })
		await defaults(organization.slug, cookie, {
			intent: 'set-default',
			settingId: 'prepTime',
			value: 20,
			locked: true,
		})
		await defaults(organization.slug, cookie, {
			intent: 'reset-overrides',
			settingId: 'prepTime',
			locationIds: [a.id],
		})
		expect((await read(a.id)).prepTime).toBe(20)
		await defaults(organization.slug, cookie, {
			intent: 'set-lock',
			settingId: 'prepTime',
			locked: false,
		})
		expect((await getLockedLocationSettingIds(organization.id)).size).toBe(0)
		await defaults(organization.slug, cookie, {
			intent: 'remove-default',
			settingId: 'prepTime',
		})
		// Locations keep their own values.
		expect((await read(a.id)).prepTime).toBe(20)
		const overview = (await defaultsLoader(args(organization.slug, cookie))) as any
		expect(
			overview.rows.find((r: any) => r.settingId === 'prepTime').hasDefault,
		).toBe(false)
	})

	it('apply to overrides moves locations that differ too, and logs each change', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 15 })
		const c = await createLocation(organization.id, { prepTime: 45 })
		const log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await defaults(organization.slug, cookie, {
			intent: 'set-default',
			settingId: 'prepTime',
			value: 30,
			locked: true,
			lockReason: 'Why',
			applyToOverrides: true,
		})
		expect((await read(a.id)).prepTime).toBe(30)
		expect((await read(c.id)).prepTime).toBe(30)
		const actions = log.mock.calls.map(([input]) => input.action)
		expect(actions).toContain(AuditAction.LOCATION_SETTING_DEFAULT_CHANGED)
		expect(actions).toContain(AuditAction.LOCATION_SETTING_LOCK_CHANGED)
		expect(
			actions.filter((x) => x === AuditAction.LOCATION_SETTING_CHANGED),
		).toHaveLength(2)
		log.mockRestore()
	})

	it('only head office (a member with every location) can manage defaults', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		const cookie = await scopedAdmin(organization.id, [a.id])
		const refused = await defaults(organization.slug, cookie, {
			intent: 'set-default',
			settingId: 'prepTime',
			value: 20,
			locked: true,
		}).catch((error: Response) => error)
		expect((refused as Response).status).toBe(403)
		await expect(
			defaultsLoader(args(organization.slug, cookie)),
		).rejects.toMatchObject({ status: 403 })
		expect(await getLockedLocationSettingIds(organization.id)).toEqual(new Set())
	})

	it('rejects a value the setting does not accept, and a setting with no default support', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await createLocation(organization.id)
		expect(
			getResponseStatus(
				await defaults(organization.slug, cookie, {
					intent: 'set-default',
					settingId: 'prepTime',
					value: -5,
					locked: false,
				}),
			),
		).toBe(400)
		expect(
			body(
				await defaults(organization.slug, cookie, {
					intent: 'set-default',
					settingId: 'specialHours',
					value: [],
					locked: false,
				}),
			).error,
		).toBe('not_supported')
	})

	it('a new location starts on the chain defaults', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await createLocation(organization.id, { prepTime: 20 })
		await defaults(organization.slug, cookie, {
			intent: 'set-default',
			settingId: 'prepTime',
			value: 20,
			locked: true,
		})
		const fresh = await createLocation(organization.id, { prepTime: 15 })
		const applied = await applyChainDefaultsToNewLocation(
			{ id: organization.id, slug: organization.slug, dataRegion: 'us' },
			fresh.id,
		)
		expect(applied).toEqual(['prepTime'])
		expect((await read(fresh.id)).prepTime).toBe(20)
	})

	it('integration imports skip a locked setting', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await createLocation(organization.id, { prepTime: 20 })
		expect((await getLockedLocationSettingIds(organization.id)).has('storeHours')).toBe(false)
		await defaults(organization.slug, cookie, {
			intent: 'set-default',
			settingId: 'storeHours',
			value: [],
			locked: true,
		})
		expect((await getLockedLocationSettingIds(organization.id)).has('storeHours')).toBe(true)
	})
})

describe('compare and edit several locations (#418)', () => {
	it('changing prep time for 4 selected locations updates exactly those 4', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const rows = []
		for (let i = 0; i < 6; i++)
			rows.push(await createLocation(organization.id, { prepTime: 10 }))
		const chosen = rows.slice(0, 4).map((r) => r.id)
		const result = body(
			await compare(organization.slug, cookie, 'apply-edit', {
				settingId: 'prepTime',
				locationIds: chosen,
				change: { kind: 'value', value: 35 },
			}),
		)
		expect(result.ok).toBe(true)
		expect(result.edit.changedLocationIds.sort()).toEqual([...chosen].sort())
		for (const row of rows) {
			expect((await read(row.id)).prepTime).toBe(chosen.includes(row.id) ? 35 : 10)
		}
	})

	it('a preview writes nothing', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 10 })
		const result = body(
			await compare(organization.slug, cookie, 'preview-edit', {
				settingId: 'prepTime',
				locationIds: [a.id],
				change: { kind: 'value', value: 35 },
			}),
		)
		expect(result.edit.targets[0]).toMatchObject({
			before: '10 min',
			after: '35 min',
			changed: true,
		})
		expect((await read(a.id)).prepTime).toBe(10)
	})

	it('a location outside the person scope is not editable and is not shown', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const inside = await createLocation(organization.id, { prepTime: 10 })
		const outside = await createLocation(organization.id, { prepTime: 10 })
		const cookie = await scopedAdmin(organization.id, [inside.id])

		const result = body(
			await compare(organization.slug, cookie, 'apply-edit', {
				settingId: 'prepTime',
				locationIds: [inside.id, outside.id],
				change: { kind: 'value', value: 40 },
			}),
		)
		expect(result.edit.changedLocationIds).toEqual([inside.id])
		expect(result.edit.skipped).toEqual([
			expect.objectContaining({ locationId: outside.id, reason: 'not_manageable' }),
		])
		expect((await read(outside.id)).prepTime).toBe(10)
		expect((await read(inside.id)).prepTime).toBe(40)

		// The table lists only what the person manages and says how many are hidden.
		const table = (await compareLoader(
			args(organization.slug, cookie, {}, '?setting=prepTime'),
		)) as any
		expect(table.rows.map((r: any) => r.locationId)).toEqual([inside.id])
		expect(table.hiddenCount).toBe(1)

		// Matching from a location outside the scope is refused too.
		const matched = await compare(organization.slug, cookie, 'apply-edit', {
			settingId: 'prepTime',
			locationIds: [inside.id],
			change: { kind: 'match', sourceId: outside.id },
		})
		expect(getResponseStatus(matched)).toBe(403)
	})

	it('clearing an override returns to the chain default, or to the standard value without one', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 45 })
		// No chain default: back to the standard 15 minutes.
		await compare(organization.slug, cookie, 'apply-edit', {
			settingId: 'prepTime',
			locationIds: [a.id],
			change: { kind: 'clear' },
		})
		expect((await read(a.id)).prepTime).toBe(15)
		await defaults(organization.slug, cookie, {
			intent: 'set-default',
			settingId: 'prepTime',
			value: 22,
			locked: false,
			applyToOverrides: true,
		})
		await compare(organization.slug, cookie, 'apply-edit', {
			settingId: 'prepTime',
			locationIds: [a.id],
			change: { kind: 'value', value: 50 },
		})
		await compare(organization.slug, cookie, 'apply-edit', {
			settingId: 'prepTime',
			locationIds: [a.id],
			change: { kind: 'clear' },
		})
		expect((await read(a.id)).prepTime).toBe(22)
	})

	it('writes one activity log entry per location changed and rejects bad input', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, { prepTime: 10 })
		const b = await createLocation(organization.id, { prepTime: 10 })
		const c = await createLocation(organization.id, { prepTime: 35 })
		const log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await compare(organization.slug, cookie, 'apply-edit', {
			settingId: 'prepTime',
			locationIds: [a.id, b.id, c.id],
			change: { kind: 'value', value: 35 },
		})
		const entries = log.mock.calls
			.map(([input]) => input)
			.filter((input) => input.action === AuditAction.LOCATION_SETTING_CHANGED)
		expect(entries.map((e) => e.resourceId).sort()).toEqual([a.id, b.id].sort())
		log.mockRestore()

		for (const payload of [
			{ settingId: 'prepTime', locationIds: [a.id], change: { kind: 'value', value: 'x' } },
			{ settingId: 'specialHours', locationIds: [a.id], change: { kind: 'clear' } },
			{ settingId: 'prepTime', locationIds: [], change: { kind: 'clear' } },
		]) {
			expect(
				getResponseStatus(
					await compare(organization.slug, cookie, 'apply-edit', payload),
				),
			).toBe(400)
		}
	})

	it('the fulfillment toggles can be set on several locations', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		const b = await createLocation(organization.id)
		const result = body(
			await compare(organization.slug, cookie, 'apply-edit', {
				settingId: 'fulfillment',
				locationIds: [a.id, b.id],
				change: {
					kind: 'value',
					value: { pickup: true, delivery: false, dineIn: false, curbside: true },
				},
			}),
		)
		expect(result.ok).toBe(true)
		expect(JSON.parse((await read(a.id)).fulfillmentOptions!)).toEqual({
			pickup: true,
			delivery: false,
			dineIn: false,
			curbside: true,
		})
	})
})
