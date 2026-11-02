import {
	db,
	Discount,
	eq,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { type DiscountsAccess } from './access.server.ts'
import { getDiscount } from './discounts.server.ts'
import { emptyEditorState, type EditorState } from './editor-model.ts'
import { saveDiscountEditor } from './save.server.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => {}),
}))

async function setup(
	features = { enabled: true, automatic: true, coupons: true },
	currency: 'USD' | 'SAR' = 'USD',
) {
	const { user, organization } = await setupTestOrgWithUser()
	const access: DiscountsAccess = {
		userId: user.id,
		organization: {
			id: organization.id,
			slug: organization.slug,
			dataRegion: null,
		},
		features,
		canWrite: true,
		currency,
		locationIds: null,
	}
	return { access }
}

function saveRequest(
	fields: Record<string, string>,
	state?: Partial<EditorState>,
) {
	const form = new FormData()
	for (const [key, value] of Object.entries(fields)) form.set(key, value)
	if (state) {
		form.set(
			'state',
			JSON.stringify({
				...emptyEditorState(),
				name: { en: 'Lunch' },
				percent: '10',
				...state,
			}),
		)
	}
	return new Request('http://localhost/x', { method: 'POST', body: form })
}

async function create(
	access: DiscountsAccess,
	state: Partial<EditorState> = {},
) {
	const result = await saveDiscountEditor({
		request: saveRequest({ intent: 'save', status: 'active' }, state),
		params: { orgSlug: access.organization.slug },
		access,
	})
	if (!(result instanceof Response)) throw new Error('create failed')
	const id = new URL(result.headers.get('Location')!, 'http://x').pathname
		.split('/')
		.pop()!
	const row = await getDiscount(access.organization.id, id)
	expect(row?.stored?.definition.status).toBe('paused')
	const activated = await saveDiscountEditor({
		request: saveRequest({
			intent: 'set-status',
			discountId: id,
			expectedVersion: '1',
			status: 'active',
		}),
		params: { orgSlug: access.organization.slug, discountId: id },
		access,
	})
	if (!(activated instanceof Response)) throw new Error('activate failed')
	return id
}

function body(result: unknown) {
	return result as { data: Record<string, unknown>; init: { status: number } }
}

async function addLocation(
	organizationId: string,
	name: string,
	country: 'CA' | 'US',
) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name,
			slug: `loc-${crypto.randomUUID().slice(0, 8)}`,
			address: JSON.stringify({ country }),
		})
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

describe('saveDiscountEditor', () => {
	describe('currency follows the locations', () => {
		const fixed = { valueType: 'fixed', percent: '', amount: '5' } as const

		it('stores CAD for a CAD-only organization in a US region', async () => {
			const { access } = await setup()
			await addLocation(access.organization.id, 'Toronto', 'CA')
			const id = await create(access, fixed)
			const row = (await getDiscount(access.organization.id, id))?.row
			expect(row).toMatchObject({ amountMinor: 500, currency: 'CAD' })
		})

		it('refuses an amount on "all locations" when the locations mix currencies', async () => {
			const { access } = await setup()
			await addLocation(access.organization.id, 'Toronto', 'CA')
			await addLocation(access.organization.id, 'Boston', 'US')
			const result = await saveDiscountEditor({
				request: saveRequest({ intent: 'save', status: 'active' }, fixed),
				params: { orgSlug: access.organization.slug },
				access,
			})
			expect(body(result).init.status).toBe(400)
			expect(body(result).data.errors).toMatchObject({
				locations: 'mixed_currencies',
				amount: 'mixed_currencies',
			})
			const rows = await db
				.select()
				.from(Discount)
				.where(eq(Discount.organizationId, access.organization.id))
			expect(rows).toHaveLength(0)
		})

		it('takes the currency of chosen locations that share one', async () => {
			const { access } = await setup()
			const toronto = await addLocation(access.organization.id, 'Toronto', 'CA')
			await addLocation(access.organization.id, 'Boston', 'US')
			const id = await create(access, {
				...fixed,
				allLocations: false,
				locationIds: [toronto],
			})
			const row = (await getDiscount(access.organization.id, id))?.row
			expect(row?.currency).toBe('CAD')
		})

		it('still saves a percentage when the locations mix currencies', async () => {
			const { access } = await setup()
			await addLocation(access.organization.id, 'Toronto', 'CA')
			await addLocation(access.organization.id, 'Boston', 'US')
			const id = await create(access)
			const row = (await getDiscount(access.organization.id, id))?.row
			expect(row?.currency).toBeNull()
		})
	})

	it('keeps the operator edits after a stale save', async () => {
		const { access } = await setup()
		const id = await create(access)
		const result = await saveDiscountEditor({
			request: saveRequest(
				{ intent: 'save', status: 'active', expectedVersion: '7' },
				{ name: { en: 'Mine' } },
			),
			params: { orgSlug: access.organization.slug, discountId: id },
			access,
		})
		expect(body(result).data).toEqual({ stale: true, keepEdits: true })
		expect(body(result).init.status).toBe(409)
	})

	it('names a switched-off way of applying instead of a bare error', async () => {
		const { access } = await setup({
			enabled: true,
			automatic: true,
			coupons: false,
		})
		const result = await saveDiscountEditor({
			request: saveRequest(
				{ intent: 'save', status: 'active' },
				{
					application: 'code',
					codes: [{ key: 'a', id: null, code: 'LUNCH10', maxUses: '' }],
				},
			),
			params: { orgSlug: access.organization.slug },
			access,
		})
		expect(body(result).data).toEqual({
			errors: { application: 'application_off' },
		})
	})

	it('still lets an existing discount be edited after its way of applying is switched off', async () => {
		const { access } = await setup()
		const id = await create(access)
		const off = {
			...access,
			features: { enabled: true, automatic: false, coupons: true },
		}
		const result = await saveDiscountEditor({
			request: saveRequest(
				{ intent: 'save', status: 'active', expectedVersion: '2' },
				{ name: { en: 'Renamed' } },
			),
			params: { orgSlug: access.organization.slug, discountId: id },
			access: off,
		})
		expect(result).toBeInstanceOf(Response)
		const loaded = await getDiscount(access.organization.id, id)
		expect(loaded?.row.name).toBe('Renamed')
	})

	it('keeps the currency the amounts were entered in', async () => {
		const { access } = await setup()
		const id = await create(access, {
			valueType: 'fixed',
			percent: '',
			amount: '5',
		})
		expect((await getDiscount(access.organization.id, id))?.row.currency).toBe(
			'USD',
		)
		await saveDiscountEditor({
			request: saveRequest(
				{ intent: 'save', status: 'active', expectedVersion: '2' },
				{ valueType: 'fixed', percent: '', amount: '6' },
			),
			params: { orgSlug: access.organization.slug, discountId: id },
			access: { ...access, currency: 'SAR' },
		})
		const row = (await getDiscount(access.organization.id, id))?.row
		expect(row?.amountMinor).toBe(600)
		expect(row?.currency).toBe('USD')
	})

	it('saves the name in the website languages, the default as the canonical text', async () => {
		const { access } = await setup()
		await db
			.update(Organization)
			.set({
				siteLocales: JSON.stringify(['ar', 'en']),
				siteDefaultLocale: 'ar',
			})
			.where(eq(Organization.id, access.organization.id))
		const id = await create(access, {
			name: { en: 'Lunch deal', ar: 'عرض الغداء', fr: 'Déjeuner' },
			description: { en: 'Weekdays', ar: '' },
		})
		const row = await getDiscount(access.organization.id, id)
		expect(row?.stored?.definition).toMatchObject({
			name: 'عرض الغداء',
			nameI18n: { en: 'Lunch deal', ar: 'عرض الغداء' },
			description: null,
			descriptionI18n: { en: 'Weekdays' },
		})
		expect(row?.stored?.definition.nameI18n).not.toHaveProperty('fr')
	})

	it('duplicates a discount as a paused copy with the word from the form', async () => {
		const { access } = await setup()
		const id = await create(access, { name: { en: 'Lunch deal' } })
		const result = await saveDiscountEditor({
			request: saveRequest({ intent: 'duplicate', copyWord: 'نسخة' }),
			params: { orgSlug: access.organization.slug, discountId: id },
			access,
		})
		expect(result).toBeInstanceOf(Response)
		const copyId = new URL(
			(result as Response).headers.get('Location')!,
			'http://x',
		).pathname
			.split('/')
			.pop()!
		expect(copyId).not.toBe(id)
		const copy = await getDiscount(access.organization.id, copyId)
		expect(copy?.stored?.definition).toMatchObject({
			name: 'Lunch deal نسخة',
			// The default-language entry follows the copy's name.
			nameI18n: { en: 'Lunch deal نسخة' },
			status: 'paused',
		})
		const [original] = await db
			.select()
			.from(Discount)
			.where(eq(Discount.id, id))
		expect(original?.status).toBe('active')
	})

	it('cuts a long name, not the copy word', async () => {
		const { access } = await setup()
		const id = await create(access, { name: { en: 'x'.repeat(60) } })
		const result = await saveDiscountEditor({
			request: saveRequest({ intent: 'duplicate', copyWord: 'copy' }),
			params: { orgSlug: access.organization.slug, discountId: id },
			access,
		})
		const copyId = new URL(
			(result as Response).headers.get('Location')!,
			'http://x',
		).pathname
			.split('/')
			.pop()!
		const copy = await getDiscount(access.organization.id, copyId)
		const name = copy?.stored?.definition.name ?? ''
		expect(name).toHaveLength(60)
		expect(name.endsWith(' copy')).toBe(true)
	})

	it('answers archived when an archived discount is saved', async () => {
		const { access } = await setup()
		const id = await create(access)
		await saveDiscountEditor({
			request: saveRequest({
				intent: 'set-status',
				discountId: id,
				expectedVersion: '2',
				status: 'archived',
			}),
			params: { orgSlug: access.organization.slug, discountId: id },
			access,
		})
		const result = await saveDiscountEditor({
			request: saveRequest(
				{ intent: 'save', status: 'paused', expectedVersion: '3' },
				{ name: { en: 'Edited' } },
			),
			params: { orgSlug: access.organization.slug, discountId: id },
			access,
		})
		expect(body(result).data).toEqual({ archived: true })
	})

	describe('purges the public site cache after the change is stored', () => {
		const purge = vi.mocked(purgeOrganizationSiteCache)
		beforeEach(() => purge.mockClear())

		/** Records the discount's stored status at the moment the purge runs. */
		function watchPurge(access: DiscountsAccess, id: string) {
			const seen: Array<{ status: string | undefined; names: string[] }> = []
			purge.mockImplementation(async () => {
				const rows = await db
					.select()
					.from(Discount)
					.where(eq(Discount.organizationId, access.organization.id))
				seen.push({
					status: rows.find((row) => row.id === id)?.status,
					names: rows.map((row) => row.name),
				})
			})
			return seen
		}
		const calledFor = (access: DiscountsAccess) =>
			expect(purge).toHaveBeenLastCalledWith(
				access.organization.id,
				access.organization.slug,
			)
		const setStatus = (
			access: DiscountsAccess,
			id: string,
			status: string,
			expectedVersion: string,
		) =>
			saveDiscountEditor({
				request: saveRequest({
					intent: 'set-status',
					discountId: id,
					expectedVersion,
					status,
				}),
				params: { orgSlug: access.organization.slug, discountId: id },
				access,
			})

		it('after create and after update', async () => {
			const { access } = await setup()
			purge.mockImplementation(async () => {})
			const id = await create(access, { name: { en: 'First' } })
			expect(purge).toHaveBeenCalledTimes(2)
			calledFor(access)
			const seen = watchPurge(access, id)
			await saveDiscountEditor({
				request: saveRequest(
					{ intent: 'save', status: 'active', expectedVersion: '2' },
					{ name: { en: 'Second' } },
				),
				params: { orgSlug: access.organization.slug, discountId: id },
				access,
			})
			expect(purge).toHaveBeenCalledTimes(3)
			calledFor(access)
			expect(seen[0]?.names).toEqual(['Second'])
		})

		it('after pause, archive and restore', async () => {
			const { access } = await setup()
			purge.mockImplementation(async () => {})
			const id = await create(access)
			purge.mockClear()
			const seen = watchPurge(access, id)
			await setStatus(access, id, 'paused', '2')
			await setStatus(access, id, 'archived', '3')
			await setStatus(access, id, 'active', '4')
			expect(purge).toHaveBeenCalledTimes(3)
			calledFor(access)
			// Each purge ran once the new status was already stored.
			expect(seen.map((entry) => entry.status)).toEqual([
				'paused',
				'archived',
				'active',
			])
		})

		it('after duplicate', async () => {
			const { access } = await setup()
			purge.mockImplementation(async () => {})
			const id = await create(access, { name: { en: 'Lunch deal' } })
			purge.mockClear()
			const seen = watchPurge(access, id)
			await saveDiscountEditor({
				request: saveRequest({ intent: 'duplicate', copyWord: 'copy' }),
				params: { orgSlug: access.organization.slug, discountId: id },
				access,
			})
			expect(purge).toHaveBeenCalledTimes(1)
			calledFor(access)
			expect(seen[0]?.names).toHaveLength(2)
		})

		it('not when the change was refused', async () => {
			const { access } = await setup()
			purge.mockImplementation(async () => {})
			const id = await create(access)
			purge.mockClear()
			const stale = await setStatus(access, id, 'paused', '9')
			expect(body(stale).init.status).toBe(409)
			expect(purge).not.toHaveBeenCalled()
		})
	})
})
