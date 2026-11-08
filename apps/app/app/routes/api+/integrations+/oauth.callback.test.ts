import { and, db, eq, Integration, UserOrganization } from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectIntegrationActionIntent } from '#app/components/settings/cards/organization/integrations-card.tsx'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { consoleWarn } from '#tests/setup/setup-test-env.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	getResponseStatus,
} from '#tests/test-utils.ts'
import { convertSetCookieToCookie } from '#tests/utils.ts'
import { action as settingsAction } from '../../_app+/$orgSlug_+/settings+/integrations.tsx'
import { loader } from './oauth.callback.tsx'

/**
 * The whole connect round trip for a note integration, with the real
 * provider code: the settings page starts it, and the callback finishes only
 * what that browser started, for the same member, who must still manage
 * settings. Slack's demo secret keeps the provider off the network (its
 * client id is inlined from the App's env at build time, so it cannot be
 * stubbed here).
 */

const APP = 'http://localhost:3001'

beforeEach(() => {
	vi.stubEnv('SLACK_CLIENT_SECRET', 'demo-slack-client-secret')
	vi.stubEnv('INTEGRATIONS_OAUTH_STATE_SECRET', 'test-oauth-state-secret')
	// Without Slack keys in the env the provider says it uses its demo app.
	consoleWarn.mockImplementation((message: unknown) => {
		if (String(message).startsWith('SLACK_CLIENT_ID not found')) return
		throw new Error(`Unexpected console.warn: ${String(message)}`)
	})
})

afterEach(() => vi.unstubAllEnvs())

async function signedInMember(
	organizationId?: string,
	role: 'admin' | 'member' = 'admin',
) {
	const user = await insertTestUser()
	const organization = organizationId
		? { id: organizationId }
		: await createTestOrganization(user.id, role)
	if (organizationId) {
		await db.insert(UserOrganization).values({
			userId: user.id,
			organizationId,
			organizationRoleId: `org_role_${role}`,
		})
	}
	const { cookie } = await createTestSession(user.id)
	return { user, organization, cookie }
}

async function startSlack(orgSlug: string, sessionCookie: string) {
	const request = createAuthenticatedRequest(
		`${APP}/${orgSlug}/settings/integrations`,
		{
			method: 'POST',
			body: new URLSearchParams({
				intent: connectIntegrationActionIntent,
				providerName: 'slack',
			}),
		},
		sessionCookie,
	)
	const response = (await settingsAction({
		request,
		params: { orgSlug },
		context: {},
	} as any)) as Response
	expect(response.status).toBe(302)
	const authorize = new URL(response.headers.get('Location') ?? '')
	expect(authorize.origin).toBe('https://slack.com')
	return {
		state: authorize.searchParams.get('state') ?? '',
		handoff: convertSetCookieToCookie(response.headers.get('Set-Cookie') ?? ''),
	}
}

async function finish(query: Record<string, string>, cookies: string[]) {
	const request = new Request(
		`${APP}/api/integrations/oauth/callback?${new URLSearchParams(query)}`,
		{ headers: { Cookie: cookies.join('; ') } },
	)
	try {
		return (await loader({
			request,
			params: {},
			context: {},
		} as any)) as Response
	} catch (error) {
		if (error instanceof Response) return error
		throw error
	}
}

async function slackIntegrations(organizationId: string) {
	return db
		.select({ id: Integration.id })
		.from(Integration)
		.where(
			and(
				eq(Integration.organizationId, organizationId),
				eq(Integration.providerName, 'slack'),
			),
		)
}

describe('note integration OAuth callback', () => {
	it('connects for the member and organization that started it', async () => {
		const admin = await signedInMember()
		const slug = (admin.organization as { slug: string }).slug
		const { state, handoff } = await startSlack(slug, admin.cookie)
		expect(handoff).toMatch(/^integrations_oauth=/)

		const response = await finish(
			{ provider: 'slack', code: 'code-1', state },
			[admin.cookie, handoff],
		)

		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe(
			`/${slug}/settings/integrations`,
		)
		const setCookies = response.headers.getSetCookie()
		expect(
			setCookies.some(
				(cookie) =>
					cookie.startsWith('integrations_oauth=') &&
					cookie.includes('Max-Age=0'),
			),
		).toBe(true)
		await expect(
			slackIntegrations(admin.organization.id),
		).resolves.toHaveLength(1)
	})

	it('refuses a callback this browser did not start', async () => {
		const admin = await signedInMember()
		const slug = (admin.organization as { slug: string }).slug
		const { state } = await startSlack(slug, admin.cookie)

		const response = await finish(
			{ provider: 'slack', code: 'code-1', state },
			[admin.cookie],
		)

		expect(getResponseStatus(response)).toBe(400)
		await expect(
			slackIntegrations(admin.organization.id),
		).resolves.toHaveLength(0)
	})

	it('refuses another member finishing it', async () => {
		const admin = await signedInMember()
		const slug = (admin.organization as { slug: string }).slug
		const other = await signedInMember(admin.organization.id)
		const { state, handoff } = await startSlack(slug, admin.cookie)

		const response = await finish(
			{ provider: 'slack', code: 'code-1', state },
			[other.cookie, handoff],
		)

		expect(response.status).toBe(400)
		await expect(
			slackIntegrations(admin.organization.id),
		).resolves.toHaveLength(0)
	})

	it('refuses a state or provider that does not match', async () => {
		const admin = await signedInMember()
		const slug = (admin.organization as { slug: string }).slug
		const { state, handoff } = await startSlack(slug, admin.cookie)

		const queries: Array<Record<string, string>> = [
			{ provider: 'slack', code: 'code-1', state: `${state}x` },
			{ provider: 'slack', code: 'code-1' },
			{ provider: 'jira', code: 'code-1', state },
		]
		for (const query of queries) {
			const response = await finish(query, [admin.cookie, handoff])
			expect(response.status).toBe(400)
		}
		await expect(
			slackIntegrations(admin.organization.id),
		).resolves.toHaveLength(0)
	})

	it('checks the settings permission again on return', async () => {
		const admin = await signedInMember()
		const slug = (admin.organization as { slug: string }).slug
		const { state, handoff } = await startSlack(slug, admin.cookie)
		await db
			.update(UserOrganization)
			.set({ organizationRoleId: 'org_role_member' })
			.where(
				and(
					eq(UserOrganization.userId, admin.user.id),
					eq(UserOrganization.organizationId, admin.organization.id),
				),
			)

		const response = await finish(
			{ provider: 'slack', code: 'code-1', state },
			[admin.cookie, handoff],
		)

		expect(response.status).toBe(403)
		await expect(
			slackIntegrations(admin.organization.id),
		).resolves.toHaveLength(0)
	})
})

describe('Trello (OAuth 1.0a) callback', () => {
	it('finishes on a fresh isolate: the request-token secret travels in the hand-off', async () => {
		vi.stubEnv('TRELLO_API_KEY', 'trello-key')
		vi.stubEnv('TRELLO_API_SECRET', 'trello-secret')
		const realFetch = globalThis.fetch
		const exchanged: string[] = []
		vi.stubGlobal(
			'fetch',
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input instanceof Request ? input.url : input)
				if (url === 'https://trello.com/1/OAuthGetRequestToken') {
					return new Response(
						'oauth_token=req-token&oauth_token_secret=req-secret',
					)
				}
				if (url === 'https://trello.com/1/OAuthGetAccessToken') {
					exchanged.push(String(init?.body ?? ''))
					return new Response(
						'oauth_token=member-token&oauth_token_secret=member-secret',
					)
				}
				return realFetch(input, init)
			},
		)
		try {
			const admin = await signedInMember()
			const slug = (admin.organization as { slug: string }).slug
			const start = (await settingsAction({
				request: createAuthenticatedRequest(
					`${APP}/${slug}/settings/integrations`,
					{
						method: 'POST',
						body: new URLSearchParams({
							intent: connectIntegrationActionIntent,
							providerName: 'trello',
						}),
					},
					admin.cookie,
				),
				params: { orgSlug: slug },
				context: {},
			} as any)) as Response
			expect(start.status).toBe(302)
			const handoff = convertSetCookieToCookie(
				start.headers.get('Set-Cookie') ?? '',
			)

			// A different Worker isolate: no module state from the start.
			vi.resetModules()
			const { loader: freshLoader } = await import('./oauth.callback.tsx')
			const query = new URLSearchParams({
				provider: 'trello',
				oauth_token: 'req-token',
				oauth_verifier: 'verifier-1',
			})
			const response = (await freshLoader({
				request: new Request(
					`${APP}/api/integrations/oauth/callback?${query}`,
					{ headers: { Cookie: [admin.cookie, handoff].join('; ') } },
				),
				params: {},
				context: {},
			} as any)) as Response

			expect(response.status).toBe(302)
			expect(exchanged).toHaveLength(1)
			const rows = await db
				.select({ id: Integration.id })
				.from(Integration)
				.where(
					and(
						eq(Integration.organizationId, admin.organization.id),
						eq(Integration.providerName, 'trello'),
					),
				)
			expect(rows).toHaveLength(1)
		} finally {
			vi.unstubAllGlobals()
		}
	})
})
