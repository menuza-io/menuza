/**
 * Token refresh and revocation against a stored integration row: the
 * provider must only ever see decrypted tokens, a rotated refresh token must
 * be persisted, two refreshes racing must not overwrite each other, and a
 * disconnect must revoke the grant at the provider.
 */
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../setup'
import { mockDb, queryChain, resetMockDb } from '../utils/mock-database'

vi.mock('../../src/encryption', async (importOriginal) => {
	const { coerceExpiresAt } =
		await importOriginal<typeof import('../../src/encryption')>()
	const strip = (value: string) =>
		value === 'encrypted-access' ? 'old-access' : value.replace(/^enc:/, '')
	return {
		coerceExpiresAt,
		decryptToken: vi.fn(async (value: string) => strip(value)),
		encryptToken: vi.fn(async (value: string) => `enc:${value}`),
		integrationEncryption: {
			encryptTokenData: vi.fn(async (data: any) => ({
				encryptedAccessToken: `enc:${data.accessToken}`,
				encryptedRefreshToken: data.refreshToken
					? `enc:${data.refreshToken}`
					: undefined,
				expiresAt: data.expiresAt,
				iv: '',
			})),
			decryptTokenData: vi.fn(async (data: any) => ({
				accessToken: strip(data.encryptedAccessToken),
				refreshToken: data.encryptedRefreshToken
					? strip(data.encryptedRefreshToken)
					: undefined,
				expiresAt: data.expiresAt,
			})),
			validateToken: vi.fn((data: any) => {
				const needsRefresh =
					!!data.expiresAt &&
					data.expiresAt.getTime() < Date.now() + 5 * 60 * 1000
				return { isValid: !needsRefresh, needsRefresh }
			}),
		},
	}
})

import { BaseIntegrationProvider, providerRegistry } from '../../src/provider'
import { AsanaProvider } from '../../src/providers/asana/provider'
import { GitLabProvider } from '../../src/providers/gitlab/provider'
import { integrationManager } from '../../src/integration-manager'
import { tokenManager } from '../../src/token-manager'

type Row = Record<string, any>

/**
 * A one-row Integration table behind the mocked Drizzle client. `where`
 * conditions arrive as the arguments the mocked `eq`/`and` were called with.
 */
function useRow(initial: Row) {
	const row: Row = { ...initial }
	const writes: Row[] = []
	const matches = (condition: any): boolean =>
		Array.isArray(condition?.[0])
			? condition.every(matches)
			: row[condition[0]] === condition[1]

	mockDb.select.mockImplementation(() => {
		const chain = queryChain()
		chain.then = (resolve: any, reject: any) =>
			Promise.resolve([{ ...row }]).then(resolve, reject)
		return chain
	})
	mockDb.update.mockImplementation(() => {
		let values: Row = {}
		let condition: any = null
		const chain: any = {
			set: (v: Row) => ((values = v), chain),
			where: (c: any) => ((condition = c), chain),
			returning: () => chain,
			then: (resolve: any, reject: any) => {
				const applies = condition ? matches(condition) : true
				if (applies) {
					Object.assign(row, values)
					writes.push(values)
				}
				return Promise.resolve(applies ? [{ id: row.id }] : []).then(
					resolve,
					reject,
				)
			},
		}
		return chain
	})
	return { row, writes }
}

const expired = () => new Date(Date.now() - 60_000)

describe('token refresh persistence and races', () => {
	beforeEach(() => {
		resetMockDb()
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('two racing refreshes: the loser keeps the stored winner (Jira-style rotation)', async () => {
		const { row, writes } = useRow({
			id: 'int-1',
			providerName: 'jira',
			accessToken: 'enc:old-access',
			refreshToken: 'enc:r1',
			tokenExpiresAt: expired(),
			config: '{}',
		})
		const provider = {
			name: 'jira',
			refreshToken: vi.fn(async (refreshToken: string) => {
				expect(refreshToken).toBe('r1')
				// Another isolate rotates the row while this request is in flight.
				Object.assign(row, {
					accessToken: 'enc:winner-access',
					refreshToken: 'enc:r2-winner',
				})
				return { accessToken: 'loser-access', refreshToken: 'r2-loser' }
			}),
		} as any

		const result = await tokenManager.refreshStoredToken('int-1', provider)

		expect(result.success).toBe(true)
		expect(result.tokenData?.accessToken).toBe('winner-access')
		expect(row.refreshToken).toBe('enc:r2-winner')
		expect(writes).toHaveLength(0)
	})

	it('a refresh refused because another request spent the token uses the stored one', async () => {
		const { row } = useRow({
			id: 'int-1',
			providerName: 'jira',
			accessToken: 'enc:old-access',
			refreshToken: 'enc:r1',
			tokenExpiresAt: expired(),
			config: '{}',
		})
		const provider = {
			name: 'jira',
			refreshToken: vi.fn(async () => {
				Object.assign(row, {
					accessToken: 'enc:winner-access',
					refreshToken: 'enc:r2',
				})
				throw new Error('invalid_grant')
			}),
		} as any

		const result = await tokenManager.refreshStoredToken('int-1', provider)

		expect(result).toMatchObject({
			success: true,
			tokenData: { accessToken: 'winner-access' },
		})
	})

	it('a refresh refused with nothing newer stored still fails and asks for reauth', async () => {
		useRow({
			id: 'int-1',
			providerName: 'jira',
			accessToken: 'enc:old-access',
			refreshToken: 'enc:r1',
			tokenExpiresAt: expired(),
			config: '{}',
		})
		const provider = {
			name: 'jira',
			refreshToken: vi.fn(async () => {
				throw new Error('invalid_grant')
			}),
		} as any

		const result = await tokenManager.refreshStoredToken('int-1', provider)

		expect(result).toMatchObject({ success: false, requiresReauth: true })
	})

	it('generic 401 retry refreshes with the decrypted refresh token and persists it', async () => {
		class Probe extends BaseIntegrationProvider {
			readonly name = 'probe'
			readonly type = 'productivity' as const
			readonly displayName = 'Probe'
			readonly description = ''
			readonly logoPath = ''
			getAuthUrl = vi.fn()
			handleCallback = vi.fn()
			refreshToken = vi.fn(async (_token: string) => ({
				accessToken: 'new-access',
				refreshToken: 'r2',
			}))
			getAvailableChannels = vi.fn()
			postMessage = vi.fn()
			validateConnection = vi.fn()
			getConfigSchema = vi.fn()
			call(integration: any) {
				return this.makeAuthenticatedRequest(
					integration,
					'https://probe.test/api',
				)
			}
		}
		const { row } = useRow({
			id: 'int-1',
			providerName: 'probe',
			accessToken: 'encrypted-access',
			refreshToken: 'enc:r1',
			tokenExpiresAt: null,
			config: '{}',
		})
		const seen: string[] = []
		server.use(
			http.get('https://probe.test/api', ({ request }) => {
				const auth = request.headers.get('Authorization') ?? ''
				seen.push(auth)
				return auth === 'Bearer new-access'
					? HttpResponse.json({ ok: true })
					: new HttpResponse(null, { status: 401 })
			}),
		)
		const probe = new Probe()

		const response = await probe.call({ ...row })

		expect(probe.refreshToken).toHaveBeenCalledWith('r1', {
			config: row.config,
		})
		expect(response.status).toBe(200)
		expect(seen).toEqual(['Bearer old-access', 'Bearer new-access'])
		expect(row.refreshToken).toBe('enc:r2')
	})

	it('GitLab 401: refreshes with the decrypted token and persists the rotated pair', async () => {
		const { row } = useRow({
			id: 'int-1',
			providerName: 'gitlab',
			accessToken: 'enc:old-access',
			refreshToken: 'enc:gl-r1',
			tokenExpiresAt: null,
			// As the OAuth flow stores a gitlab.com integration.
			config: JSON.stringify({
				metadata: { instanceUrl: 'https://gitlab.com' },
			}),
		})
		let refreshSent: string | undefined
		server.use(
			http.post('https://gitlab.com/oauth/token', async ({ request }) => {
				refreshSent = ((await request.json()) as any).refresh_token
				return HttpResponse.json({
					access_token: 'gl-new-access',
					refresh_token: 'gl-r2',
					expires_in: 7200,
				})
			}),
			http.get('https://gitlab.com/api/v4/projects', ({ request }) =>
				request.headers.get('Authorization') === 'Bearer gl-new-access'
					? HttpResponse.json([])
					: new HttpResponse('expired', {
							status: 401,
							statusText: 'Unauthorized',
						}),
			),
		)

		await new GitLabProvider().getAvailableChannels({ ...row } as any)

		expect(refreshSent).toBe('gl-r1')
		expect(row.accessToken).toBe('enc:gl-new-access')
		expect(row.refreshToken).toBe('enc:gl-r2')
	})

	it('Asana: an expired access token is refreshed and persisted before use', async () => {
		const { row } = useRow({
			id: 'int-1',
			providerName: 'asana',
			accessToken: 'encrypted-access',
			refreshToken: 'enc:as-r1',
			tokenExpiresAt: expired(),
			config: '{}',
		})
		let refreshSent: string | null = null
		let usedToken: string | null = null
		server.use(
			http.post('https://app.asana.com/-/oauth_token', async ({ request }) => {
				refreshSent = new URLSearchParams(await request.text()).get(
					'refresh_token',
				)
				return HttpResponse.json({
					access_token: 'as-new-access',
					expires_in: 3600,
				})
			}),
			http.get('https://app.asana.com/api/1.0/workspaces', ({ request }) => {
				usedToken = request.headers.get('Authorization')
				return HttpResponse.json({ data: [] })
			}),
		)

		await new AsanaProvider().getAvailableChannels({ ...row } as any)

		expect(refreshSent).toBe('as-r1')
		expect(usedToken).toBe('Bearer as-new-access')
		expect(row.accessToken).toBe('enc:as-new-access')
		expect(row.refreshToken).toBe('enc:as-r1')
	})

	it('disconnect revokes the grant at the provider, and still disconnects when that fails', async () => {
		useRow({
			id: 'int-1',
			organizationId: 'org-1',
			providerName: 'gitlab',
			accessToken: 'enc:gl-access',
			refreshToken: 'enc:gl-r1',
			tokenExpiresAt: null,
			config: '{}',
		})
		const gitlab = new GitLabProvider()
		providerRegistry.register(gitlab)
		const revoke = vi
			.spyOn(gitlab, 'revokeToken')
			.mockRejectedValueOnce(new Error('provider down'))

		await integrationManager.disconnectIntegration('int-1')

		expect(revoke).toHaveBeenCalledWith(
			'gl-access',
			expect.objectContaining({ id: 'int-1' }),
			{ signal: expect.any(AbortSignal) },
		)
		expect(mockDb.delete).toHaveBeenCalledTimes(3)
	})
})
