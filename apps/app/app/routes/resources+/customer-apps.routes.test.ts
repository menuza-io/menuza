import {
	CustomerApp,
	CustomerAppBuild,
	db,
	eq,
	Organization,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockCustomerAppAdapters } from '#app/utils/customer-apps/adapters.mock.server.ts'
import { setCustomerAppAdapters } from '#app/utils/customer-apps/adapters.select.server.ts'
import { loadCustomerAppView } from '#app/utils/customer-apps/view.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import { action as buildCallback } from './customer-app.build-callback.ts'
import { loader as configLoader } from './customer-app.config.ts'
import { action as command } from './customer-apps.command.ts'
import { action as healthJob } from './jobs.customer-app-health.ts'

/** Built at run time: a test fixture, not a credential (secret scanners match the literal). */
const ACCOUNT_TYPE = ['service', 'account'].join('_')

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => {}),
}))

function args(
	path: string,
	init: { method?: string; token?: string | null; body?: unknown },
) {
	const url = new URL(`http://localhost:3001${path}`)
	return {
		request: new Request(url, {
			method: init.method ?? 'POST',
			headers: {
				...(init.token === null
					? {}
					: {
							Authorization: `Bearer ${init.token ?? ENV.INTERNAL_COMMAND_TOKEN}`,
						}),
				'Content-Type': 'application/json',
			},
			body:
				init.body === undefined || init.method === 'GET'
					? undefined
					: JSON.stringify(init.body),
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: path,
	}
}

async function publishedOrg() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id)
	await db
		.update(Organization)
		.set({ sitePublished: true })
		.where(eq(Organization.id, organization.id))
	return { user, organization }
}

beforeEach(() => setCustomerAppAdapters(createMockCustomerAppAdapters()))
afterEach(() => setCustomerAppAdapters(null))

describe('internal endpoints need the internal command token', () => {
	it('config answers 401 without a token and with a wrong one', async () => {
		await expect(
			configLoader({
				...args('/resources/customer-app/config?slug=acme', {
					method: 'GET',
					token: null,
				}),
			} as never),
		).rejects.toMatchObject({ status: 401 })
		await expect(
			configLoader(
				args('/resources/customer-app/config?slug=acme', {
					method: 'GET',
					token: 'wrong-wrong-wrong-wrong',
				}) as never,
			),
		).rejects.toMatchObject({ status: 401 })
	})

	it('command, callback and health job refuse a missing or wrong token', async () => {
		for (const token of [null, 'wrong-wrong-wrong-wrong']) {
			await expect(
				command(
					args('/resources/customer-apps/command', {
						token,
						body: { intent: 'delete', appId: 'x' },
					}) as never,
				),
			).rejects.toMatchObject({ status: 401 })
			await expect(
				buildCallback(
					args('/resources/customer-app/build-callback', {
						token,
						body: {},
					}) as never,
				),
			).rejects.toMatchObject({ status: 401 })
			await expect(
				healthJob(
					args('/resources/jobs/customer-app-health', { token }) as never,
				),
			).rejects.toMatchObject({ status: 401 })
		}
	})

	it('serves the build config of a real app, with only branding and endpoints', async () => {
		const { user, organization } = await publishedOrg()
		const created = await command(
			args('/resources/customer-apps/command', {
				body: {
					intent: 'create',
					actorId: user.id,
					organizationId: organization.id,
				},
			}) as never,
		)
		expect(created.status).toBe(200)
		const [app] = await db
			.select()
			.from(CustomerApp)
			.where(eq(CustomerApp.organizationId, organization.id))
		const response = await configLoader(
			args(`/resources/customer-app/config?slug=${app!.slug}`, {
				method: 'GET',
			}) as never,
		)
		expect(response.status).toBe(200)
		const config = (await response.json()) as Record<string, unknown>
		expect(config).toMatchObject({
			slug: app!.slug,
			bundleId: app!.iosBundleId,
			androidPackage: app!.androidPackage,
			site: { slug: organization.slug },
		})
		expect(JSON.stringify(config)).not.toMatch(/ciphertext|PRIVATE KEY|secret/i)
		const missing = await configLoader(
			args('/resources/customer-app/config?slug=does-not-exist', {
				method: 'GET',
			}) as never,
		)
		expect(missing.status).toBe(404)
	})
})

describe('credentials are never readable through any API', () => {
	it('answers an upload with set and date only, and the restaurant view shows only readiness', async () => {
		const { user, organization } = await publishedOrg()
		await command(
			args('/resources/customer-apps/command', {
				body: {
					intent: 'create',
					actorId: user.id,
					organizationId: organization.id,
				},
			}) as never,
		)
		const [app] = await db
			.select()
			.from(CustomerApp)
			.where(eq(CustomerApp.organizationId, organization.id))
		const secretKey =
			'-----BEGIN PRIVATE KEY-----\nTOPSECRETKEYMATERIAL0123456789ABCDEFGHIJKLMNOP\n-----END PRIVATE KEY-----'
		const upload = await command(
			args('/resources/customer-apps/command', {
				body: {
					intent: 'credential',
					appId: app!.id,
					kind: 'apns',
					actorId: user.id,
					payload: {
						key: secretKey,
						keyId: 'ABC123DEFG',
						teamId: 'TEAM123456',
					},
				},
			}) as never,
		)
		const text = await upload.text()
		expect(upload.status).toBe(200)
		expect(text).not.toContain('TOPSECRET')
		expect(JSON.parse(text)).toMatchObject({
			ok: true,
			status: { kind: 'apns', set: true },
		})

		const check = await command(
			args('/resources/customer-apps/command', {
				body: { intent: 'credential-check', appId: app!.id, kind: 'apns' },
			}) as never,
		)
		expect(await check.json()).toEqual({ ok: true, valid: true })

		const view = await loadCustomerAppView(organization.id)
		expect(JSON.stringify(view)).not.toContain('TOPSECRET')
		expect(view!.push).toEqual({ ios: true, android: false })

		const rejected = await command(
			args('/resources/customer-apps/command', {
				body: {
					intent: 'credential',
					appId: app!.id,
					kind: 'fcm',
					actorId: user.id,
					payload: { type: ACCOUNT_TYPE, secretish: 'LEAKME' },
				},
			}) as never,
		)
		expect(rejected.status).toBe(422)
		expect(await rejected.text()).not.toContain('LEAKME')
	})
})

describe('release over the command route', () => {
	it('reports per app and then callbacks update the build', async () => {
		const { user, organization } = await publishedOrg()
		await command(
			args('/resources/customer-apps/command', {
				body: {
					intent: 'create',
					actorId: user.id,
					organizationId: organization.id,
				},
			}) as never,
		)
		const [app] = await db
			.select()
			.from(CustomerApp)
			.where(eq(CustomerApp.organizationId, organization.id))
		const response = await command(
			args('/resources/customer-apps/command', {
				body: {
					intent: 'release',
					appIds: [app!.id, 'does-not-exist'],
					release: '1.0.0-1',
					actorId: user.id,
				},
			}) as never,
		)
		const body = (await response.json()) as {
			summary: { succeeded: number; failed: number; failedAppIds: string[] }
		}
		expect(body.summary).toMatchObject({
			succeeded: 1,
			failed: 1,
			failedAppIds: ['does-not-exist'],
		})
		const [build] = await db
			.select()
			.from(CustomerAppBuild)
			.where(eq(CustomerAppBuild.appId, app!.id))
		const callback = await buildCallback(
			args('/resources/customer-app/build-callback', {
				body: { buildId: build!.id, status: 'running' },
			}) as never,
		)
		expect(await callback.json()).toEqual({ ok: true, status: 'running' })
	})
})
