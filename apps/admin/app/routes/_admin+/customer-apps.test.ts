import { randomUUID } from 'node:crypto'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import {
	CustomerApp,
	CustomerAppBuild,
	CustomerAppCredential,
	db,
	eq,
	Organization,
	Permission,
	Role,
	Session,
	User,
	_PermissionToRole,
	_RoleToUser,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { action, detailLoader, listLoader } from './customer-apps.server.ts'

const postToApp = vi.hoisted(() => vi.fn())
vi.mock('#app/utils/app-service.server.ts', () => ({ postToApp }))

async function signedIn(options: { permitted: boolean }) {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com` })
		.returning()
	await db
		.insert(Role)
		.values({ name: 'admin', description: 'admin' })
		.onConflictDoNothing()
	const role = await db.query.Role.findFirst({ where: eq(Role.name, 'admin') })
	await db.insert(_RoleToUser).values({ A: role!.id, B: user!.id })
	if (options.permitted) {
		await db
			.insert(Permission)
			.values({
				id: 'sys_perm_update_customer_app_any',
				action: 'update',
				entity: 'customer_app',
				access: 'any',
				context: 'system',
				description: 'Manage branded customer apps',
			})
			.onConflictDoNothing()
		await db
			.insert(_PermissionToRole)
			.values({ A: 'sys_perm_update_customer_app_any', B: role!.id })
			.onConflictDoNothing()
	}
	const [session] = await db
		.insert(Session)
		.values({ userId: user!.id, expirationDate: getSessionExpirationDate() })
		.returning()
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session!.id)
	const cookie = await authSessionStorage.commitSession(authSession)
	return { cookie, userId: user!.id }
}

function args(
	cookie: string,
	path: string,
	init: { form?: Record<string, string>; params?: Record<string, string> } = {},
) {
	const url = new URL(`http://localhost:3004${path}`)
	return {
		request: new Request(url, {
			method: init.form ? 'POST' : 'GET',
			headers: { Cookie: cookie },
			body: init.form ? new URLSearchParams(init.form) : undefined,
		}),
		params: init.params ?? {},
		context: new RouterContextProvider(),
		url,
		pattern: path,
	} as never
}

async function appWithCredential() {
	const [organization] = await db
		.insert(Organization)
		.values({ name: 'Org', slug: `org-${randomUUID()}`, sitePublished: true })
		.returning()
	const appId = randomUUID()
	await db.insert(CustomerApp).values({
		id: appId,
		organizationId: organization!.id,
		slug: `slug-${appId}`,
		displayName: 'Acme',
		iosBundleId: `com.acme.${appId.slice(0, 8)}`,
		androidPackage: `com.acme.a${appId.slice(0, 8).replace(/-/g, '')}`,
	})
	await db.insert(CustomerAppCredential).values({
		appId,
		kind: 'apns',
		ciphertext: 'CIPHERTEXT-SENTINEL-DO-NOT-LEAK',
	})
	await db
		.insert(CustomerAppBuild)
		.values({ appId, release: '1.0.0-1', platform: 'ios', status: 'failed' })
	return { appId, organizationId: organization!.id }
}

beforeEach(() => postToApp.mockReset())

describe('Admin customer apps (#156)', () => {
	it('needs update:customer_app:any: members without it get 403 on every entry point', async () => {
		const { cookie } = await signedIn({ permitted: false })
		await expect(
			listLoader(args(cookie, '/customer-apps')),
		).rejects.toMatchObject({ status: 403 })
		await expect(
			detailLoader(
				args(cookie, '/customer-apps/x', { params: { appId: 'x' } }),
			),
		).rejects.toMatchObject({ status: 403 })
		await expect(
			action(
				args(cookie, '/customer-apps', {
					form: { _action: 'delete', appId: 'x' },
				}),
			),
		).rejects.toMatchObject({ status: 403 })
		expect(postToApp).not.toHaveBeenCalled()
	})

	it('never selects a credential: loader data holds set and date only', async () => {
		const { cookie } = await signedIn({ permitted: true })
		const { appId } = await appWithCredential()
		const detail = await detailLoader(
			args(cookie, `/customer-apps/${appId}`, { params: { appId } }),
		)
		expect(detail.credentials).toEqual([
			{ kind: 'apns', set: true, uploadedAt: expect.any(String) },
			{ kind: 'fcm', set: false, uploadedAt: null },
		])
		expect(JSON.stringify(detail)).not.toMatch(/CIPHERTEXT|ciphertext/)
		const list = await listLoader(args(cookie, '/customer-apps'))
		expect(JSON.stringify(list)).not.toMatch(/CIPHERTEXT|ciphertext/)
		const row = list.apps.find((app) => app.id === appId)
		expect(row?.latestRelease).toBe('1.0.0-1')
		expect(row?.latestBuilds).toEqual([{ platform: 'ios', status: 'failed' }])
	})

	it('sends an upload to the App as a command and answers without the value', async () => {
		const { cookie, userId } = await signedIn({ permitted: true })
		postToApp.mockResolvedValue({
			status: 'answered',
			response: new Response(
				JSON.stringify({ ok: true, status: { kind: 'fcm', set: true } }),
				{ status: 200 },
			),
		})
		const result = await action(
			args(cookie, '/customer-apps/x', {
				form: {
					_action: 'credential-fcm',
					appId: 'app-1',
					serviceAccount:
						'{"type":"service_account","private_key":"SECRET-JSON"}',
				},
			}),
		)
		expect(result).toEqual({ ok: true })
		expect(JSON.stringify(result)).not.toContain('SECRET-JSON')
		expect(postToApp).toHaveBeenCalledWith(
			'/resources/customer-apps/command',
			expect.objectContaining({
				intent: 'credential',
				kind: 'fcm',
				actorId: userId,
			}),
			expect.anything(),
		)
	})

	it('a release reports per-app outcomes and offers retries for the failed ones', async () => {
		const { cookie } = await signedIn({ permitted: true })
		const { appId } = await appWithCredential()
		postToApp.mockResolvedValue({
			status: 'answered',
			response: new Response(
				JSON.stringify({
					ok: true,
					outcomes: [
						{ appId, ok: true, buildIds: ['b1'] },
						{
							appId: 'other',
							ok: false,
							code: 'pipeline_refused',
							message: 'The build pipeline did not accept this build.',
						},
					],
					summary: {
						total: 2,
						succeeded: 1,
						failed: 1,
						failedAppIds: ['other'],
					},
				}),
				{ status: 200 },
			),
		})
		const result = await action(
			args(cookie, '/customer-apps', {
				form: { _action: 'release', release: '2.0.0-1' },
			}),
		)
		expect(result).toMatchObject({
			ok: true,
			summary: { succeeded: 1, failed: 1 },
		})
		const body = postToApp.mock.calls[0]![1] as {
			intent: string
			appIds: string[]
			release: string
		}
		expect(body).toMatchObject({ intent: 'release', release: '2.0.0-1' })
		expect(body.appIds).toContain(appId)
	})

	it('shows an App error plainly', async () => {
		const { cookie } = await signedIn({ permitted: true })
		postToApp.mockResolvedValue({
			status: 'answered',
			response: new Response(
				JSON.stringify({
					ok: false,
					code: 'bundle_id_taken',
					message: 'taken',
				}),
				{ status: 422 },
			),
		})
		expect(
			await action(
				args(cookie, '/customer-apps', {
					form: { _action: 'create', organizationId: 'org-1' },
				}),
			),
		).toEqual({ ok: false, code: 'bundle_id_taken', message: 'taken' })
	})
})
