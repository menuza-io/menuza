import {
	db,
	Integration,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import { merchantIds } from '@repo/integrations'
import {
	posSandboxHandlers,
	resetPosSandbox,
} from '@repo/integrations/pos/sandbox'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	goLiveStoreActionIntent,
	saveStoreSettingsActionIntent,
} from '#app/components/settings/cards/organization/pos-integrations-card.tsx'
import {
	action as integrationsAction,
	loader as integrationsLoader,
} from '#app/routes/_app+/$orgSlug_+/settings+/integrations.tsx'
import { INTEGRATION_FLAG_KEYS } from '#app/utils/integrations/flags.server.ts'
import { server } from '#tests/mocks/index.ts'
import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'

const flags = vi.hoisted(() => ({ on: new Set<string>() }))
vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: vi.fn(async (key: string) => flags.on.has(key)),
}))

describe('integrations route store settings & go-live (#96)', () => {
	beforeEach(() => {
		flags.on.clear()
		flags.on.add(INTEGRATION_FLAG_KEYS.storeSettings)
		resetPosSandbox()
		server.use(...posSandboxHandlers)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('loads storeSettings and readiness and handles save-store-settings & go-live-store', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const [location] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: organization.id,
				name: JSON.stringify({ en: 'Main' }),
				slug: `main-${Date.now()}`,
				timezone: 'America/New_York',
				address: JSON.stringify({ formattedAddress: '100 Market St' }),
				phone: '+14155550100',
				email: 'main@example.com',
				isDefault: true,
			})
			.returning()

		const [uber] = await db
			.insert(Integration)
			.values({
				organizationId: organization.id,
				organizationLocationId: location!.id,
				providerName: 'ubereats',
				providerType: 'delivery',
				isActive: true,
				config: JSON.stringify({
					environment: 'sandbox',
					merchantId: merchantIds.ubereats,
				}),
			})
			.returning()

		const [menu] = await db
			.insert(OrganizationMenu)
			.values({
				organizationId: organization.id,
				displayName: JSON.stringify({ en: 'Dinner' }),
				position: 0,
			})
			.returning()

		const [cat] = await db
			.insert(OrganizationMenuCategory)
			.values({
				organizationId: organization.id,
				displayName: JSON.stringify({ en: 'Mains' }),
			})
			.returning()
		await db.insert(OrganizationMenuCategoryAssignment).values({
			menuId: menu!.id,
			categoryId: cat!.id,
			position: 0,
		})
		const [item] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: organization.id,
				displayName: JSON.stringify({ en: 'Pasta' }),
				price: 15,
				imageUrl: 'https://cdn.example.com/pasta.jpg',
				imageKey: 'pasta.jpg',
			})
			.returning()
		await db.insert(OrganizationMenuItemCategoryAssignment).values({
			categoryId: cat!.id,
			itemId: item!.id,
			position: 0,
		})

		const loaderReq = createAuthenticatedRequest(
			`http://localhost/${organization.slug}/settings/integrations`,
			{},
			cookie,
		)
		const loaderData = await integrationsLoader({
			request: loaderReq,
			params: { orgSlug: organization.slug },
			context: {} as never,
		} as never)
		expect(loaderData.storeSettingsEnabled).toBe(true)
		const uberDto = loaderData.integrations.find((i) => i.id === uber!.id)
		expect(uberDto?.readiness?.ready).toBe(false)
		expect(
			uberDto?.readiness?.reasons.some((r) => r.code === 'no_menus_selected'),
		).toBe(true)

		// Refuses go-live before menu is selected (400)
		const goLiveBlockedForm = new FormData()
		goLiveBlockedForm.set('intent', goLiveStoreActionIntent)
		goLiveBlockedForm.set('integrationId', uber!.id)
		const blockedRes = (await integrationsAction({
			request: createAuthenticatedRequest(
				`http://localhost/${organization.slug}/settings/integrations`,
				{ method: 'POST', body: goLiveBlockedForm },
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {} as never,
		} as never)) as Response
		expect(blockedRes.status).toBe(400)

		// Save store settings
		const saveForm = new FormData()
		saveForm.set('intent', saveStoreSettingsActionIntent)
		saveForm.set('integrationId', uber!.id)
		saveForm.append('menuIds', menu!.id)
		saveForm.set('holidaySync', 'true')
		const saveRes = (await integrationsAction({
			request: createAuthenticatedRequest(
				`http://localhost/${organization.slug}/settings/integrations`,
				{ method: 'POST', body: saveForm },
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {} as never,
		} as never)) as Response
		expect(saveRes.status).toBe(200)
		const saveJson = (await saveRes.json()) as {
			ok: boolean
			readiness: { ready: boolean }
		}
		expect(saveJson.ok).toBe(true)
		expect(saveJson.readiness.ready).toBe(true)

		// Go live succeeds
		const goLiveForm = new FormData()
		goLiveForm.set('intent', goLiveStoreActionIntent)
		goLiveForm.set('integrationId', uber!.id)
		const goLiveRes = (await integrationsAction({
			request: createAuthenticatedRequest(
				`http://localhost/${organization.slug}/settings/integrations`,
				{ method: 'POST', body: goLiveForm },
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {} as never,
		} as never)) as Response
		expect(goLiveRes.status).toBe(200)
	})
})
