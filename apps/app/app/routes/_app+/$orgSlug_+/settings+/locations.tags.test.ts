import { db, eq, OrganizationLocation } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { resolveMemberLocationIds } from '#app/utils/location/member-scope.server.ts'
import { listLocationTags } from '#app/utils/location/tags.server.ts'
import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader as reportsNewLoader } from '../reports+/new.tsx'
import { action, loader } from './locations.tags.tsx'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(true),
}))
vi.mock('#app/utils/reservations/access.server.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	notifyReservationsContextChanged: vi.fn().mockResolvedValue(undefined),
}))

async function createLocation(organizationId: string, name: string) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name,
			slug: `l-${crypto.randomUUID().slice(0, 8)}`,
		})
		.returning()
	return row!
}

const body = (result: any) => result?.data ?? result

function call(
	orgSlug: string,
	cookie: string,
	fields: Record<string, string | string[] | File>,
) {
	const form = new FormData()
	for (const [key, value] of Object.entries(fields)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			form.append(key, item as string)
		}
	}
	const url = new URL(`https://app.test/${orgSlug}/settings/locations/tags`)
	return action({
		request: createAuthenticatedRequest(
			url.toString(),
			{ method: 'POST', body: form },
			cookie,
		),
		params: { orgSlug },
		context: new RouterContextProvider(),
		url,
		pattern: '/:orgSlug/settings/locations/tags',
	} as never) as Promise<any>
}

function csvFile(text: string) {
	return new File([text], 'locations.csv', { type: 'text/csv' })
}

async function scopedCookie(organizationId: string, ids: string[]) {
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, 'org_role_admin')
	await setMemberLocationScope({
		organizationId,
		userId: user.id,
		value: { scope: 'selected', locationIds: ids },
	})
	return (await createTestSession(user.id)).cookie
}

describe('location tags page (#374)', () => {
	it('creates, renames, assigns and deletes tags, refusing duplicates and the limit', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, 'Austin')
		const created = body(
			await call(organization.slug, cookie, {
				intent: 'create-tag',
				name: ' Texas ',
			}),
		)
		expect(created.ok).toBe(true)
		const [tag] = await listLocationTags(organization.id)
		expect(tag!.name).toBe('Texas')
		expect(
			getResponseStatus(
				await call(organization.slug, cookie, {
					intent: 'create-tag',
					name: 'texas',
				}),
			),
		).toBe(409)
		await call(organization.slug, cookie, {
			intent: 'set-tag-locations',
			tagId: tag!.id,
			locationIds: [a.id],
		})
		expect((await listLocationTags(organization.id))[0]!.locationIds).toEqual([
			a.id,
		])
		await call(organization.slug, cookie, {
			intent: 'rename-tag',
			tagId: tag!.id,
			name: 'TX',
		})
		expect((await listLocationTags(organization.id))[0]!.name).toBe('TX')
		await call(organization.slug, cookie, {
			intent: 'delete-tag',
			tagId: tag!.id,
		})
		expect(await listLocationTags(organization.id)).toEqual([])

		for (let i = 0; i < 50; i++) {
			await call(organization.slug, cookie, {
				intent: 'create-tag',
				name: `tag ${i}`,
			})
		}
		const over = await call(organization.slug, cookie, {
			intent: 'create-tag',
			name: 'one too many',
		})
		expect(getResponseStatus(over)).toBe(400)
		expect(body(over).error).toBe('limit_reached')
	})

	it('only head office can manage tags: a location-scoped member cannot widen their own access', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, 'Austin')
		const b = await createLocation(organization.id, 'Boston')
		await call(organization.slug, cookie, {
			intent: 'create-tag',
			name: 'Mine',
		})
		const [tag] = await listLocationTags(organization.id)
		const scoped = await scopedCookie(organization.id, [a.id])
		const refused = await call(organization.slug, scoped, {
			intent: 'set-tag-locations',
			tagId: tag!.id,
			locationIds: [a.id, b.id],
		}).catch((error: Response) => error)
		expect((refused as Response).status).toBe(403)
		expect((await listLocationTags(organization.id))[0]!.locationIds).toEqual(
			[],
		)
		await expect(
			loader({
				request: createAuthenticatedRequest(
					`https://app.test/${organization.slug}/settings/locations/tags`,
					{},
					scoped,
				),
				params: { orgSlug: organization.slug },
				context: new RouterContextProvider(),
			} as never),
		).rejects.toMatchObject({ status: 403 })
	})

	it('a CSV with one bad row reports it and applies nothing', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, 'Austin')
		const b = await createLocation(organization.id, 'Boston')
		const csv = [
			'id,name,slug,phone,active,tags',
			`${a.id},Austin,${a.slug},555-0100,yes,Texas`,
			`${b.id},Boston,${b.slug},not a phone!,yes,Texas`,
		].join('\n')

		const preview = body(
			await call(organization.slug, cookie, {
				intent: 'preview-csv',
				file: csvFile(csv),
			}),
		)
		expect(preview.csv.plan.problems).toEqual([
			expect.objectContaining({ row: 3, problem: 'bad_phone' }),
		])
		const applied = body(
			await call(organization.slug, cookie, {
				intent: 'apply-csv',
				file: csvFile(csv),
			}),
		)
		expect(applied.csv.applied).toBe(false)
		expect(applied.csv.plan.problems).toHaveLength(1)

		// Nothing happened: no tag, no phone, no link.
		expect(await listLocationTags(organization.id)).toEqual([])
		const [rowA] = await db
			.select()
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, a.id))
		expect(rowA!.phone).toBeNull()
	})

	it('a good CSV creates the tags and applies every row in one go', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, 'Austin')
		const b = await createLocation(organization.id, 'Boston')
		const csv = [
			'id,name,slug,phone,active,tags',
			`${a.id},Austin,${a.slug},555-0100,yes,Texas`,
			`${b.id},Boston,${b.slug},,no,"Texas; East"`,
		].join('\n')
		const result = body(
			await call(organization.slug, cookie, {
				intent: 'apply-csv',
				file: csvFile(csv),
			}),
		)
		expect(result.csv.applied).toBe(true)
		const tags = await listLocationTags(organization.id)
		expect(tags.map((t) => t.name).sort()).toEqual(['East', 'Texas'])
		expect(tags.find((t) => t.name === 'Texas')!.locationIds.sort()).toEqual(
			[a.id, b.id].sort(),
		)
		const [rowB] = await db
			.select()
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, b.id))
		expect(rowB!.isActive).toBe(false)
		const [rowA] = await db
			.select()
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, a.id))
		expect(rowA!.phone).toBe('555-0100')

		// The download reads back as no change.
		const download = (await loader({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/settings/locations/tags?download=csv`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(download.headers.get('content-type')).toContain('text/csv')
		const again = body(
			await call(organization.slug, cookie, {
				intent: 'preview-csv',
				file: csvFile(await download.text()),
			}),
		)
		expect(again.csv.plan.changes).toEqual([])
	})

	it('reports can be filtered by tag, limited to the locations the person may see', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id, 'Austin')
		const b = await createLocation(organization.id, 'Boston')
		const c = await createLocation(organization.id, 'Cairo')
		await call(organization.slug, cookie, {
			intent: 'create-tag',
			name: 'Group',
		})
		const [tag] = await listLocationTags(organization.id)
		await call(organization.slug, cookie, {
			intent: 'set-tag-locations',
			tagId: tag!.id,
			locationIds: [a.id, b.id],
		})
		const open = async (cookieValue: string, query: string) =>
			(await reportsNewLoader({
				request: createAuthenticatedRequest(
					`https://app.test/${organization.slug}/reports/new?${query}`,
					{},
					cookieValue,
				),
				params: { orgSlug: organization.slug },
				context: new RouterContextProvider(),
			} as never)) as any
		const locationCondition = (loaded: any) =>
			JSON.stringify(loaded.definition.filters)

		const filtered = await open(
			cookie,
			`template=sales-by-location&tag=${tag!.id}`,
		)
		expect(locationCondition(filtered)).toContain('"operator":"in"')
		expect(locationCondition(filtered)).toContain('Austin')
		expect(locationCondition(filtered)).toContain('Boston')
		expect(locationCondition(filtered)).not.toContain('Cairo')

		// A manager who sees only Austin gets only Austin from the same tag.
		const scoped = await scopedCookie(organization.id, [a.id, c.id])
		const limited = await open(
			scoped,
			`template=sales-by-location&tag=${tag!.id}`,
		)
		expect(locationCondition(limited)).toContain('Austin')
		expect(locationCondition(limited)).not.toContain('Boston')

		// A made-up tag changes nothing.
		const unknown = await open(cookie, 'template=sales-by-location&tag=nope')
		expect(locationCondition(unknown)).not.toContain('"in"')
		expect(await resolveMemberLocationIds('x', organization.id)).toEqual([])
	})
})
