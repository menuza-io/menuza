import { faker } from '@faker-js/faker'
import { db, eq, Organization, PhoneAgent } from '@repo/database'
import { DEFAULT_PHONE_AGENT_SETTINGS } from '@repo/phone-agent'
import { describe, expect, it, vi } from 'vitest'
import {
	getPhoneAgent,
	updatePhoneAgentSettings,
} from './phone-agent.server.ts'
import {
	parseVerticalSettings,
	patchPhoneAgentSettings,
	settingsVersions,
	toFieldErrors,
} from './settings-patch.server.ts'

// The defaults turn on staff transfers without a staff phone, which no
// save accepts.
const VALID_SETTINGS = { ...DEFAULT_PHONE_AGENT_SETTINGS, autoEscalate: false }

// A vertical with settings of its own, whichever one this deployment picks.
vi.mock('./vertical.ts', async () => {
	const { z } = await import('zod')
	const { generalVertical } = await import('@repo/phone-agent')
	return {
		phoneAgentVertical: {
			...generalVertical,
			id: 'test',
			settings: {
				schema: z.object({
					remindersEnabled: z.boolean().default(true),
					reminderHours: z.number().int().min(1).default(24),
				}),
				defaults: { remindersEnabled: true, reminderHours: 24 },
			},
		},
		businessMessageVariables: (business: string) => ({ business }),
	}
})
vi.mock('./vertical.server.ts', async () => {
	const { generalServerVertical } = await import('./vertical-general.server.ts')
	return { phoneAgentServerVertical: generalServerVertical }
})

vi.mock('./settings-history.server.ts', () => ({
	recordSettingsChange: vi.fn(),
}))

async function setup() {
	const [organization] = await db
		.insert(Organization)
		.values({
			name: faker.company.name(),
			slug: `patch-${Date.now()}-${faker.string.alphanumeric(6).toLowerCase()}`,
		})
		.returning()
	const orgId = organization!.id
	await getPhoneAgent(orgId)
	await db
		.update(PhoneAgent)
		.set({ settings: JSON.stringify(VALID_SETTINGS) })
		.where(eq(PhoneAgent.organizationId, orgId))
	const agent = await getPhoneAgent(orgId)
	return { orgId, versions: settingsVersions(agent.settings) }
}

function patch(
	orgId: string,
	settingsPatch: Record<string, unknown>,
	versions: Record<string, string>,
) {
	return patchPhoneAgentSettings({
		organizationId: orgId,
		userId: 'user',
		patch: settingsPatch,
		versions,
	})
}

describe('settingsVersions', () => {
	it('changes only for the keys whose values changed', () => {
		const before = settingsVersions(DEFAULT_PHONE_AGENT_SETTINGS)
		const after = settingsVersions({
			...DEFAULT_PHONE_AGENT_SETTINGS,
			agentName: 'Sam',
		})
		expect(after.agentName).not.toBe(before.agentName)
		expect(after.greeting).toBe(before.greeting)
		expect(after.faq).toBe(before.faq)
	})
})

describe('patchPhoneAgentSettings', () => {
	it('saves when the versions match the stored settings', async () => {
		const { orgId, versions } = await setup()
		const result = await patch(
			orgId,
			{ agentName: 'Sam' },
			{ agentName: versions.agentName! },
		)
		expect(result.ok).toBe(true)
		expect((await getPhoneAgent(orgId)).settings.agentName).toBe('Sam')
	})

	it('refuses a save based on stale values of the same key', async () => {
		const { orgId, versions } = await setup()
		const stale = { agentName: versions.agentName! }
		expect((await patch(orgId, { agentName: 'First' }, stale)).ok).toBe(true)
		const second = await patch(orgId, { agentName: 'Second' }, stale)
		expect(second).toEqual({ ok: false, error: 'conflict' })
		expect((await getPhoneAgent(orgId)).settings.agentName).toBe('First')
	})

	it('keeps changes other pages made to other keys', async () => {
		const { orgId, versions } = await setup()
		await patch(
			orgId,
			{ greeting: 'Hello there' },
			{ greeting: versions.greeting! },
		)
		const result = await patch(
			orgId,
			{ agentName: 'Sam' },
			{ agentName: versions.agentName! },
		)
		expect(result.ok).toBe(true)
		const { settings } = await getPhoneAgent(orgId)
		expect(settings.greeting).toBe('Hello there')
		expect(settings.agentName).toBe('Sam')
	})

	it('treats a missing version as stale', async () => {
		const { orgId } = await setup()
		const result = await patch(orgId, { agentName: 'Sam' }, {})
		expect(result).toEqual({ ok: false, error: 'conflict' })
	})

	it('returns error codes for invalid fields', async () => {
		const { orgId, versions } = await setup()
		const result = await patch(
			orgId,
			{ agentName: 'x'.repeat(61) },
			{ agentName: versions.agentName! },
		)
		expect(result).toEqual({
			ok: false,
			error: 'invalid_fields',
			fieldErrors: { agentName: 'too_long:60' },
		})
	})

	it('refuses numbers outside the US and Canada', async () => {
		const { orgId, versions } = await setup()
		const result = await patch(
			orgId,
			{
				escalationPhone: '+442071234567',
				contacts: [
					{ id: 'chef', name: 'Chef', phone: '+12025550123' },
					{ id: 'owner', name: 'Owner', phone: '+18765550123' },
				],
			},
			{
				escalationPhone: versions.escalationPhone!,
				contacts: versions.contacts!,
			},
		)
		expect(result).toEqual({
			ok: false,
			error: 'invalid_fields',
			fieldErrors: {
				escalationPhone: 'phone_region',
				'contacts.1.phone': 'phone_region',
			},
		})
	})

	it('only rechecks stored foreign numbers on the page that saves them', async () => {
		const { orgId } = await setup()
		await db
			.update(PhoneAgent)
			.set({
				settings: JSON.stringify({
					...VALID_SETTINGS,
					escalationPhone: '+442071234567',
				}),
			})
			.where(eq(PhoneAgent.organizationId, orgId))
		const agent = await getPhoneAgent(orgId)
		expect(agent.settings.escalationPhone).toBe('+442071234567')
		const versions = settingsVersions(agent.settings)
		const unrelated = await patch(
			orgId,
			{ agentName: 'Sam' },
			{ agentName: versions.agentName! },
		)
		expect(unrelated.ok).toBe(true)
		const staffPage = await patch(
			orgId,
			{ escalationPhone: '+442071234567' },
			{ escalationPhone: versions.escalationPhone! },
		)
		expect(staffPage).toMatchObject({
			ok: false,
			fieldErrors: { escalationPhone: 'phone_region' },
		})
	})

	it('needs call access to change staff alerts', async () => {
		const { orgId, versions } = await setup()
		const notifications = {
			...VALID_SETTINGS.notifications,
			emails: ['owner@example.com'],
		}
		const denied = await patchPhoneAgentSettings({
			organizationId: orgId,
			userId: 'user',
			patch: { notifications },
			versions: { notifications: versions.notifications! },
			canChangeAlerts: async () => false,
		})
		expect(denied).toEqual({
			ok: false,
			error: 'alerts_forbidden',
			fieldErrors: { notifications: 'alerts_forbidden' },
		})
		expect((await getPhoneAgent(orgId)).settings.notifications.emails).toEqual(
			[],
		)

		const allowed = await patchPhoneAgentSettings({
			organizationId: orgId,
			userId: 'user',
			patch: { notifications },
			versions: { notifications: versions.notifications! },
			canChangeAlerts: async () => true,
		})
		expect(allowed.ok).toBe(true)
		expect((await getPhoneAgent(orgId)).settings.notifications.emails).toEqual([
			'owner@example.com',
		])
	})

	it('lets people without call access save unchanged alerts and other keys', async () => {
		const { orgId, versions } = await setup()
		const canChangeAlerts = vi.fn(async () => false)
		const result = await patchPhoneAgentSettings({
			organizationId: orgId,
			userId: 'user',
			patch: {
				notifications: VALID_SETTINGS.notifications,
				followUp: { autoResolveAfterDays: 3, keepTransferredOpen: true },
			},
			versions: {
				notifications: versions.notifications!,
				followUp: versions.followUp!,
			},
			canChangeAlerts,
		})
		expect(result.ok).toBe(true)
		expect(canChangeAlerts).not.toHaveBeenCalled()
	})

	it('checks the call-read permission by default', async () => {
		const { orgId, versions } = await setup()
		const result = await patch(
			orgId,
			{
				notifications: {
					...VALID_SETTINGS.notifications,
					includeCallLink: false,
				},
			},
			{ notifications: versions.notifications! },
		)
		expect(result).toMatchObject({ ok: false, error: 'alerts_forbidden' })
	})

	it('does not write when the row changed after it was read', async () => {
		const { orgId } = await setup()
		const read = await getPhoneAgent(orgId)
		await db
			.update(PhoneAgent)
			.set({
				settings: JSON.stringify({ ...VALID_SETTINGS, closing: 'Bye now' }),
			})
			.where(eq(PhoneAgent.organizationId, orgId))
		const result = await updatePhoneAgentSettings(
			orgId,
			{ ...read.settings, agentName: 'Sam' },
			{ expectedRawSettings: read.rawSettings },
		)
		expect(result).toEqual({ ok: false, error: 'conflict', conflict: true })
		const { settings } = await getPhoneAgent(orgId)
		expect(settings.closing).toBe('Bye now')
		expect(settings.agentName).toBe(DEFAULT_PHONE_AGENT_SETTINGS.agentName)
	})
})

describe('toFieldErrors', () => {
	it('maps phone format issues to the phone code', async () => {
		const { PhoneAgentSettingsSchema } = await import('@repo/phone-agent')
		const parsed = PhoneAgentSettingsSchema.safeParse({
			...DEFAULT_PHONE_AGENT_SETTINGS,
			escalationPhone: '555',
		})
		expect(parsed.success).toBe(false)
		if (!parsed.success) {
			expect(toFieldErrors(parsed.error)).toMatchObject({
				escalationPhone: 'phone',
			})
		}
	})
})

describe('parseVerticalSettings', () => {
	it("fills the vertical's defaults", () => {
		const result = parseVerticalSettings({ remindersEnabled: false })
		expect(result).toEqual({
			ok: true,
			value: { remindersEnabled: false, reminderHours: 24 },
		})
	})

	it('reports invalid values under `vertical.`', () => {
		const result = parseVerticalSettings({ remindersEnabled: 'yes' })
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(Object.keys(result.fieldErrors)).toEqual([
			'vertical.remindersEnabled',
		])
	})

	it('saves vertical settings with the rest of a patch', async () => {
		const { orgId, versions } = await setup()
		const result = await patch(
			orgId,
			{ vertical: { remindersEnabled: false } },
			versions,
		)
		expect(result.ok).toBe(true)
		const agent = await getPhoneAgent(orgId)
		expect(agent.settings.vertical).toMatchObject({ remindersEnabled: false })
	})
})
