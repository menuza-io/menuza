import { db, eq, Organization, PhoneAgent } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { action, VOICE_PURGE_BATCH_SIZE } from './jobs.voice-retention.ts'

const PURGE_PATH = '/api/voice/retention/purge'

function args(init: { method?: string; authorized?: boolean } = {}) {
	const url = new URL('http://localhost:3001/resources/jobs/voice-retention')
	return {
		request: new Request(url, {
			method: init.method ?? 'POST',
			headers:
				init.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` },
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/jobs/voice-retention',
	}
}

async function createOrganization(
	options: {
		phoneAgent?: boolean
		active?: boolean
		hasProvisionedDb?: boolean
		dataRegion?: 'us' | 'ksa'
	} = {},
) {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id)
	await db
		.update(Organization)
		.set({
			active: options.active ?? true,
			hasProvisionedDb: options.hasProvisionedDb ?? true,
			dataRegion: options.dataRegion ?? 'us',
		})
		.where(eq(Organization.id, organization.id))
	if (options.phoneAgent ?? true) {
		await db
			.insert(PhoneAgent)
			.values({ organizationId: organization.id, settings: '{}' })
	}
	return organization.id
}

type PurgeCall = { url: string; orgId: string; dataRegion: string }

describe('voice retention job', () => {
	let calls: PurgeCall[]
	let respond: (orgId: string) => Promise<Response>
	let fetchSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		calls = []
		respond = async () =>
			Response.json({
				success: true,
				recordingsDeleted: 1,
				recordingsPending: 0,
				recordingsFailed: 0,
				transcriptsCleared: 2,
				requestsCleared: 1,
				followUpsResolved: 0,
			})
		fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async (input, init) => {
				const url = String(input)
				if (!url.endsWith(PURGE_PATH)) {
					throw new Error(`Unexpected fetch ${url}`)
				}
				const body = JSON.parse(String(init?.body)) as {
					orgId: string
					dataRegion: string
				}
				calls.push({ url, ...body })
				return respond(body.orgId)
			})
	})

	afterEach(() => {
		fetchSpy.mockRestore()
	})

	it('only accepts authenticated POST requests', async () => {
		expect((await action(args({ method: 'GET' }))).status).toBe(405)
		await expect(action(args({ authorized: false }))).rejects.toMatchObject({
			status: 302,
		})
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('purges every provisioned org with a phone agent, including inactive ones', async () => {
		const active = await createOrganization()
		const inactive = await createOrganization({ active: false })
		const ksa = await createOrganization({ dataRegion: 'ksa' })
		const withoutAgent = await createOrganization({ phoneAgent: false })
		const unprovisioned = await createOrganization({
			hasProvisionedDb: false,
		})

		const response = await action(args())
		expect(response.status).toBe(200)
		const purged = new Map(calls.map((call) => [call.orgId, call]))
		expect(purged.get(active)).toMatchObject({
			dataRegion: 'us',
			url: `${resolveRegionalTenantApiUrls('us').tenantApiUrl}${PURGE_PATH}`,
		})
		expect(purged.get(inactive)).toMatchObject({ dataRegion: 'us' })
		expect(purged.get(ksa)).toMatchObject({
			dataRegion: 'ksa',
			url: `${resolveRegionalTenantApiUrls('ksa').tenantApiUrl}${PURGE_PATH}`,
		})
		expect(purged.has(withoutAgent)).toBe(false)
		expect(purged.has(unprovisioned)).toBe(false)

		const body = (await response.json()) as Record<string, number | boolean>
		expect(body).toMatchObject({
			success: true,
			failed: 0,
			organizations: calls.length,
			recordingsDeleted: calls.length,
			transcriptsCleared: calls.length * 2,
			requestsCleared: calls.length,
		})
	})

	it(`runs at most ${VOICE_PURGE_BATCH_SIZE} purges at a time`, async () => {
		const orgIds = await Promise.all(
			Array.from({ length: VOICE_PURGE_BATCH_SIZE + 3 }, () =>
				createOrganization(),
			),
		)
		let inFlight = 0
		let maxInFlight = 0
		const baseRespond = respond
		respond = async (orgId) => {
			inFlight++
			maxInFlight = Math.max(maxInFlight, inFlight)
			await new Promise((resolve) => setTimeout(resolve, 5))
			inFlight--
			return baseRespond(orgId)
		}

		const response = await action(args())
		expect(response.status).toBe(200)
		const purged = new Set(calls.map((call) => call.orgId))
		for (const orgId of orgIds) expect(purged.has(orgId)).toBe(true)
		expect(maxInFlight).toBeGreaterThan(1)
		expect(maxInFlight).toBeLessThanOrEqual(VOICE_PURGE_BATCH_SIZE)
	})

	it('keeps purging other orgs when one fails and reports the failure', async () => {
		const broken = await createOrganization()
		const healthy = await createOrganization()
		const baseRespond = respond
		respond = async (orgId) =>
			orgId === broken
				? new Response('down', { status: 500 })
				: baseRespond(orgId)
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

		const response = await action(args())
		expect(response.status).toBe(502)
		expect(calls.map((call) => call.orgId)).toContain(healthy)
		const body = (await response.json()) as Record<string, number | boolean>
		expect(body).toMatchObject({
			success: false,
			failed: 1,
			organizations: calls.length,
			recordingsDeleted: calls.length - 1,
		})
		expect(errorSpy).toHaveBeenCalledWith(
			'Voice retention purge failed',
			expect.objectContaining({ organizationId: broken }),
		)
		errorSpy.mockRestore()
	})
})
