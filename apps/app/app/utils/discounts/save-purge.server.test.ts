import { db, Discount, eq } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { bindSiteDataKV } from '#app/utils/sites/kv-cache.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { type DiscountsAccess } from './access.server.ts'
import { emptyEditorState } from './editor-model.ts'
import { saveDiscountEditor } from './save.server.ts'

/**
 * The real cache module with a KV that is down: the change is already stored,
 * so every intent must still answer success (the cache TTL bounds staleness).
 */
async function setup() {
	const { user, organization } = await setupTestOrgWithUser()
	const access: DiscountsAccess = {
		userId: user.id,
		organization: {
			id: organization.id,
			slug: organization.slug,
			dataRegion: null,
		},
		features: { enabled: true, automatic: true, coupons: true },
		canWrite: true,
		currency: 'USD',
		locationIds: null,
	}
	return { access }
}

function request(fields: Record<string, string>, withState = false) {
	const form = new FormData()
	for (const [key, value] of Object.entries(fields)) form.set(key, value)
	if (withState) {
		form.set(
			'state',
			JSON.stringify({
				...emptyEditorState(),
				name: { en: 'Lunch' },
				percent: '10',
			}),
		)
	}
	return new Request('http://localhost/x', { method: 'POST', body: form })
}

describe('a failing site cache purge after the change is stored', () => {
	it('still answers success for save, pause, archive, restore and duplicate', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		bindSiteDataKV({
			list: vi.fn(async () => {
				throw new Error('KV unavailable')
			}),
			delete: vi.fn(async () => {}),
		} as never)
		const { access } = await setup()
		const params = { orgSlug: access.organization.slug }

		const created = await saveDiscountEditor({
			request: request({ intent: 'save', status: 'active' }, true),
			params,
			access,
		})
		expect(created).toBeInstanceOf(Response)
		const id = new URL(
			(created as Response).headers.get('Location')!,
			'http://x',
		).pathname
			.split('/')
			.pop()!

		const updated = await saveDiscountEditor({
			request: request(
				{ intent: 'save', status: 'active', expectedVersion: '1' },
				true,
			),
			params: { ...params, discountId: id },
			access,
		})
		expect(updated).toBeInstanceOf(Response)
		expect((updated as Response).status).toBe(302)

		let version = 2
		for (const status of ['paused', 'archived', 'active']) {
			const result = await saveDiscountEditor({
				request: request({
					intent: 'set-status',
					discountId: id,
					expectedVersion: String(version),
					status,
				}),
				params,
				access,
			})
			expect(result).toMatchObject({ data: { ok: true } })
			version += 1
			const [row] = await db.select().from(Discount).where(eq(Discount.id, id))
			expect(row?.status).toBe(status)
		}

		const copy = await saveDiscountEditor({
			request: request({ intent: 'duplicate', copyWord: 'copy' }),
			params: { ...params, discountId: id },
			access,
		})
		expect(copy).toBeInstanceOf(Response)
		expect((copy as Response).status).toBe(302)
		expect(error).toHaveBeenCalled()
	})
})
