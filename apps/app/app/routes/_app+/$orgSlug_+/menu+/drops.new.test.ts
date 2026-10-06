import { beforeEach, describe, expect, it, vi } from 'vitest'
import { action } from './drops.new.tsx'

const mocks = vi.hoisted(() => ({
	requireUserOrganization: vi.fn(),
	saveDrop: vi.fn(),
	purgeOrganizationSiteCache: vi.fn(),
}))

vi.mock('@repo/auth', () => ({ requireUserId: vi.fn() }))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: mocks.requireUserOrganization,
}))
vi.mock('#app/utils/menu/drops.server.ts', () => ({ saveDrop: mocks.saveDrop }))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: mocks.purgeOrganizationSiteCache,
}))

function requestWithTitle(title: string) {
	const body = new FormData()
	body.set('intent', 'draft')
	body.set('menuId', 'menu-1')
	body.set('title', title)
	body.set(
		'description',
		JSON.stringify({ en: 'Special batch', ar: 'دفعة خاصة' }),
	)
	return new Request('https://app.example/cafe/menu/drops/new', {
		method: 'POST',
		body,
	})
}

describe('create drop localization', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.requireUserOrganization.mockResolvedValue({
			id: 'org-1',
			slug: 'cafe',
			siteDefaultLocale: 'en',
		})
		mocks.saveDrop.mockResolvedValue('drop-1')
	})

	it('requires a name in the default site language even for a draft', async () => {
		const response = await action({
			request: requestWithTitle(JSON.stringify({ ar: 'مخبوزات السبت' })),
			params: { orgSlug: 'cafe' },
		} as any)

		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			errors: { title: ['Add a drop name in the default site language.'] },
		})
		expect(mocks.saveDrop).not.toHaveBeenCalled()
	})

	it('saves translated names and notes without flattening other languages', async () => {
		const title = JSON.stringify({ en: 'Saturday bake', ar: 'مخبوزات السبت' })
		const response = await action({
			request: requestWithTitle(title),
			params: { orgSlug: 'cafe' },
		} as any)

		expect(response.status).toBe(302)
		expect(mocks.saveDrop).toHaveBeenCalledWith(
			'org-1',
			expect.objectContaining({
				title,
				description: JSON.stringify({
					en: 'Special batch',
					ar: 'دفعة خاصة',
				}),
			}),
		)
	})
})
