import { describe, expect, it, vi } from 'vitest'
import { type DiscountsAccess } from './access.server.ts'
import { MAX_CODES_PER_ORG, MAX_DISCOUNTS_PER_ORG } from './discounts.server.ts'
import { emptyEditorState } from './editor-model.ts'
import { DISCOUNTS_LIMIT, ORG_CODES_LIMIT } from './limits.ts'
import { saveDiscountEditor } from './save.server.ts'

const mocks = vi.hoisted(() => ({
	createDiscount: vi.fn(),
	updateDiscount: vi.fn(),
	duplicateDiscount: vi.fn(),
	setDiscountStatus: vi.fn(),
	getDiscountApplication: vi.fn(),
}))

vi.mock('./discounts.server.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	...mocks,
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => {}),
}))

const access = {
	userId: 'user_1',
	organization: { id: 'org_1', slug: 'acme', dataRegion: null },
	features: { enabled: true, automatic: true, coupons: true },
	canWrite: true,
	currency: 'USD',
	locationIds: null,
} as DiscountsAccess

function request(fields: Record<string, string>, state?: object) {
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

/** A stored discount at every location: in scope for the unscoped `access`. */
const STORED_ORG_WIDE = {
	application: 'automatic',
	currency: 'USD',
	locationIds: null,
}

function result(value: unknown) {
	return value as { data: Record<string, unknown>; init: { status: number } }
}

describe('organization limits', () => {
	it('keeps the editor numbers equal to the ones the server enforces', () => {
		expect(DISCOUNTS_LIMIT).toBe(MAX_DISCOUNTS_PER_ORG)
		expect(ORG_CODES_LIMIT).toBe(MAX_CODES_PER_ORG)
	})

	it('reports the discount cap as a limit with no field error', async () => {
		mocks.createDiscount.mockResolvedValueOnce({
			ok: false,
			reason: 'too_many_discounts',
		})
		const saved = result(
			await saveDiscountEditor({
				request: request({ intent: 'save', status: 'active' }, {}),
				params: { orgSlug: 'acme' },
				access,
			}),
		)
		expect(saved.init.status).toBe(409)
		expect(saved.data).toEqual({ limit: 'discounts' })
	})

	it('marks the codes field when a save hits the organization code cap', async () => {
		mocks.createDiscount.mockResolvedValueOnce({
			ok: false,
			reason: 'too_many_codes',
		})
		const saved = result(
			await saveDiscountEditor({
				request: request(
					{ intent: 'save', status: 'active' },
					{
						application: 'code',
						codes: [{ key: 'c', id: null, code: 'LUNCH10', maxUses: '' }],
					},
				),
				params: { orgSlug: 'acme' },
				access,
			}),
		)
		expect(saved.data).toEqual({
			errors: { codes: 'org_codes_limit' },
			limit: 'codes',
		})
	})

	it('answers a refused duplicate with the limit alone', async () => {
		mocks.getDiscountApplication.mockResolvedValue(STORED_ORG_WIDE)
		for (const reason of ['too_many_discounts', 'too_many_codes'] as const) {
			mocks.duplicateDiscount.mockResolvedValueOnce({ ok: false, reason })
			const saved = result(
				await saveDiscountEditor({
					request: request({ intent: 'duplicate', discountId: 'disc_1' }),
					params: { orgSlug: 'acme' },
					access,
				}),
			)
			expect(saved.init.status).toBe(409)
			expect(saved.data).toEqual({
				limit: reason === 'too_many_codes' ? 'codes' : 'discounts',
			})
		}
	})

	it('answers a refused restore with the limit alone', async () => {
		mocks.getDiscountApplication.mockResolvedValue(STORED_ORG_WIDE)
		mocks.setDiscountStatus.mockResolvedValueOnce({
			ok: false,
			reason: 'too_many_discounts',
		})
		const saved = result(
			await saveDiscountEditor({
				request: request({
					intent: 'set-status',
					discountId: 'disc_1',
					expectedVersion: '2',
					status: 'paused',
				}),
				params: { orgSlug: 'acme' },
				access,
			}),
		)
		expect(saved.data).toEqual({ limit: 'discounts' })
	})
})

describe('currencies orders cannot count in yet', () => {
	it('refuses an amount on the server too, and still saves a percentage', async () => {
		// Today an organization is USD or SAR; a stored discount can hold another.
		const kwd = { ...access, currency: 'KWD' } as unknown as DiscountsAccess
		const refused = result(
			await saveDiscountEditor({
				request: request(
					{ intent: 'save', status: 'active' },
					{ valueType: 'fixed', percent: '', amount: '1.000' },
				),
				params: { orgSlug: 'acme' },
				access: kwd,
			}),
		)
		expect(refused.init.status).toBe(400)
		expect(refused.data).toEqual({
			errors: { valueType: 'amounts_unavailable' },
		})
		expect(mocks.createDiscount).not.toHaveBeenCalledWith(
			expect.objectContaining({
				definition: expect.objectContaining({ amountMinor: 1000 }),
			}),
		)

		mocks.createDiscount.mockResolvedValueOnce({ ok: true, id: 'disc_9' })
		const saved = await saveDiscountEditor({
			request: request({ intent: 'save', status: 'active' }, {}),
			params: { orgSlug: 'acme' },
			access: kwd,
		})
		expect(saved).toBeInstanceOf(Response)
	})
})
