import { faker } from '@faker-js/faker'
import {
	db,
	eq,
	Organization,
	OrganizationLocation,
	PhoneAgent,
	PhoneAgentNumber,
	PlatformPhoneNumber,
} from '@repo/database'
import {
	DEFAULT_PHONE_AGENT_SETTINGS,
	type PhoneAgentPassthrough,
} from '@repo/phone-agent'
import { describe, expect, it, vi } from 'vitest'
import { getPhoneAgent } from '../phone-agent.server.ts'
import { buildRuntimeConfig } from '../runtime-config.server.ts'
import {
	parseVerticalSettings,
	patchPhoneAgentSettings,
	settingsVersions,
} from '../settings-patch.server.ts'

vi.mock('../settings-history.server.ts', () => ({
	recordSettingsChange: vi.fn(),
}))

function uniqueUsNumber() {
	return `+14155${faker.string.numeric(6)}`
}

async function createOrganization() {
	const [organization] = await db
		.insert(Organization)
		.values({
			name: faker.company.name(),
			slug: `restaurant-${Date.now()}-${faker.string.alphanumeric(6).toLowerCase()}`,
		})
		.returning()
	return organization!.id
}

describe('restaurant phone numbers', () => {
	async function setup() {
		const orgId = await createOrganization()
		const restaurantLine = uniqueUsNumber()
		const [location] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: orgId,
				name: 'Main',
				slug: `main-${faker.string.alphanumeric(6).toLowerCase()}`,
				phone: `(${restaurantLine.slice(2, 5)}) ${restaurantLine.slice(5, 8)}-${restaurantLine.slice(8)}`,
				isDefault: true,
			})
			.returning()
		const [platformNumber] = await db
			.insert(PlatformPhoneNumber)
			.values({
				e164: uniqueUsNumber(),
				assignedOrganizationId: orgId,
				assignedAt: new Date(),
			})
			.returning()
		await db.insert(PhoneAgentNumber).values({
			organizationId: orgId,
			scopeId: location!.id,
			platformNumberId: platformNumber!.id,
			e164: platformNumber!.e164,
			mode: 'forwarding',
			forwardedFrom: restaurantLine,
			isActive: true,
			verifiedAt: new Date(),
		})
		return { orgId, locationId: location!.id, platformNumber: platformNumber! }
	}

	it('reports an inactive location instead of answering for another', async () => {
		const input = await setup()
		const escalationPhone = uniqueUsNumber()
		await getPhoneAgent(input.orgId)
		await db
			.update(PhoneAgent)
			.set({
				settings: JSON.stringify({
					...DEFAULT_PHONE_AGENT_SETTINGS,
					enabled: true,
					escalationPhone,
				}),
			})
			.where(eq(PhoneAgent.organizationId, input.orgId))
		await db
			.update(OrganizationLocation)
			.set({ isActive: false })
			.where(eq(OrganizationLocation.id, input.locationId))
		const result = await buildRuntimeConfig({
			kind: 'number',
			calledNumber: input.platformNumber.e164,
		})
		expect(result).toMatchObject({
			ok: false,
			status: 409,
			error: 'This line is not in service right now',
		})
		if (result.ok) return
		expect((result.passthrough as PhoneAgentPassthrough).phone).toBe(
			escalationPhone,
		)
	})
})

describe('restaurant vertical settings', () => {
	it("fills the restaurant's defaults", () => {
		const result = parseVerticalSettings({ upsellsEnabled: false })
		expect(result).toMatchObject({
			ok: true,
			value: { upsellsEnabled: false, ordering: expect.any(Object) },
		})
	})

	it('reports invalid values under `vertical.`', () => {
		const result = parseVerticalSettings({ upsellsEnabled: 'yes' })
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(Object.keys(result.fieldErrors)).toEqual(['vertical.upsellsEnabled'])
	})

	it('saves restaurant settings with the rest of a patch', async () => {
		const orgId = await createOrganization()
		await getPhoneAgent(orgId)
		await db
			.update(PhoneAgent)
			.set({
				settings: JSON.stringify({
					...DEFAULT_PHONE_AGENT_SETTINGS,
					autoEscalate: false,
				}),
			})
			.where(eq(PhoneAgent.organizationId, orgId))
		const agent = await getPhoneAgent(orgId)
		const result = await patchPhoneAgentSettings({
			organizationId: orgId,
			userId: 'user',
			patch: { vertical: { upsellsEnabled: false } },
			versions: settingsVersions(agent.settings),
		})
		expect(result.ok).toBe(true)
		expect((await getPhoneAgent(orgId)).settings.vertical).toMatchObject({
			upsellsEnabled: false,
		})
	})
})
