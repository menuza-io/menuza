import { ConfigFlag, db, OrganizationLocation } from '@repo/database'
import { ENV } from 'varlock/env'
import { describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action as skipStep } from '../../api+/onboarding+/skip-step.tsx'
import { action as launchStatus } from '../../resources+/launch-status.ts'
import { action, loader } from './launch.tsx'

vi.mock('#app/utils/dashboards/regional-home.server.ts', () => ({
	loadLaunchFacts: vi.fn(async () => ({
		pairedLocationIds: [],
		firstOrderAt: '2026-04-02T09:00:00.000Z',
	})),
	loadStockSoldOutItemIds: vi.fn(async () => []),
}))

async function enableLaunch(organizationId: string) {
	await db.insert(ConfigFlag).values({
		key: 'launch.checklist',
		value: true,
		level: 'organization',
		organizationId,
	})
}

async function createLocation(organizationId: string) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name: 'Olaya',
			slug: `loc-${crypto.randomUUID().slice(0, 8)}`,
		})
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

function unwrap(result: unknown) {
	const body =
		result && typeof result === 'object' && 'data' in result
			? (result as { data: unknown }).data
			: result
	return { status: getResponseStatus(result), body }
}

function skip(cookie: string, fields: Record<string, string>) {
	const request = createAuthenticatedRequest(
		'http://localhost:3000/api/onboarding/skip-step',
		{ method: 'POST', body: new URLSearchParams(fields) },
		cookie,
	)
	return skipStep({ request, params: {}, context: {} } as any)
}

describe('/<orgSlug>/launch', () => {
	it('is not found while launch.checklist is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const request = createAuthenticatedRequest(
			`http://localhost:3000/${organization.slug}/launch`,
			{},
			cookie,
		)
		await expect(
			loader({ request, params: { orgSlug: organization.slug } } as any),
		).rejects.toMatchObject({ init: { status: 404 } })
	})

	it('shows the checklist to members and opens a draft for Tell your guests', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableLaunch(organization.id)
		await createLocation(organization.id)
		const request = createAuthenticatedRequest(
			`http://localhost:3000/${organization.slug}/launch`,
			{},
			cookie,
		)
		const data = await loader({
			request,
			params: { orgSlug: organization.slug },
		} as any)
		expect(data.checklist.locations[0]!.steps).toHaveLength(9)
		expect(data.canSkip).toBe(true)

		const tell = await action({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/launch`,
				{
					method: 'POST',
					body: new URLSearchParams({ intent: 'tell-guests' }),
				},
				cookie,
			),
			params: { orgSlug: organization.slug },
		} as any)
		// Only a draft: the campaign page opens with the launch template.
		expect((tell as Response).headers.get('Location')).toBe(
			`/${organization.slug}/marketing/campaigns/new?template=launch`,
		)
	})
})

describe('POST /api/onboarding/skip-step', () => {
	it('refuses required steps with step_not_skippable', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableLaunch(organization.id)
		const locationId = await createLocation(organization.id)
		const result = unwrap(
			await skip(cookie, {
				organizationId: organization.id,
				locationId,
				stepKey: 'launch_go_live',
			}),
		)
		expect(result).toEqual({
			status: 400,
			body: { ok: false, error: 'step_not_skippable' },
		})
		const optional = unwrap(
			await skip(cookie, {
				organizationId: organization.id,
				locationId,
				stepKey: 'launch_custom_domain',
				reason: 'Not yet',
			}),
		)
		expect(optional).toEqual({ status: 200, body: { ok: true } })
	})

	it('needs the settings permission', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('guest')
		await enableLaunch(organization.id)
		const locationId = await createLocation(organization.id)
		const result = unwrap(
			await skip(cookie, {
				organizationId: organization.id,
				locationId,
				stepKey: 'launch_custom_domain',
			}),
		)
		expect(result.status).toBe(403)
	})
})

describe('POST /resources/launch-status (Admin)', () => {
	it('needs the internal command token', async () => {
		const response = (await launchStatus({
			request: new Request('http://localhost:3000/resources/launch-status', {
				method: 'POST',
				body: JSON.stringify({ organizationId: 'x' }),
			}),
			params: {},
			context: {},
		} as any)) as Response
		expect(response.status).toBe(401)
	})

	it('returns state and dates only, never a guest field', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableLaunch(organization.id)
		await createLocation(organization.id)
		const response = (await launchStatus({
			request: new Request('http://localhost:3000/resources/launch-status', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ organizationId: organization.id }),
			}),
			params: {},
			context: {},
		} as any)) as Response
		expect(response.status).toBe(200)
		const body = (await response.json()) as Record<string, unknown>
		expect(body).toMatchObject({
			enabled: true,
			firstOrderAt: '2026-04-02T09:00:00.000Z',
			daysSinceSignup: 0,
		})
		expect(JSON.stringify(body)).not.toMatch(
			/phone|email|contact|customer|guest/i,
		)
	})
})
