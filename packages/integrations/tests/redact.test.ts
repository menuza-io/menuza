import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockDb, queryChain, resetMockDb } from './utils/mock-database'

vi.mock('@repo/database', () => {
	const table = new Proxy({}, { get: (_, property) => property })
	const operator = vi.fn((...args: unknown[]) => args)
	return {
		db: mockDb,
		Integration: table,
		IntegrationLog: table,
		NoteIntegrationConnection: table,
		Organization: table,
		OrganizationNote: table,
		and: operator,
		count: operator,
		desc: operator,
		eq: operator,
		gte: operator,
		inArray: operator,
		isNull: operator,
		lt: operator,
	}
})

import {
	IntegrationManager,
	pruneOldIntegrationLogs,
} from '../src/integration-manager'
import {
	redactSecrets,
	redactSecretsInText,
	toSafeSyncErrorMessage,
	trimRawResponse,
} from '../src/redact'

describe('secret redaction and response trimming (#94)', () => {
	beforeEach(() => {
		resetMockDb()
	})

	it('redacts sensitive keys recursively while preserving non-secret counts', () => {
		const input = {
			provider: 'square',
			created: 3,
			updated: 1,
			accessToken: 'sq0atp-secret-value-123456',
			nested: {
				refresh_token: 'refresh-xyz',
				clientSecret: 'super-secret',
				apiKey: 'key-123',
				api_key: 'key-456',
				private_key: '-----BEGIN PRIVATE KEY-----',
				signature: 'sig-abc',
				jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.signature123',
				bearer: 'tok-999',
				credential: { id: 'c1', secret: 's1' },
				password: 'pw',
				authorizationHeader: 'Bearer raw-header-token',
				sessionCookie: 'sid=abc',
				menuName: 'Lunch',
			},
			items: [{ token: 't1', id: 'item-1' }],
		}

		const redacted = redactSecrets(input)

		expect(redacted.provider).toBe('square')
		expect(redacted.created).toBe(3)
		expect(redacted.updated).toBe(1)
		expect(redacted.accessToken).toBe('[REDACTED]')
		expect(redacted.nested.refresh_token).toBe('[REDACTED]')
		expect(redacted.nested.clientSecret).toBe('[REDACTED]')
		expect(redacted.nested.apiKey).toBe('[REDACTED]')
		expect(redacted.nested.api_key).toBe('[REDACTED]')
		expect(redacted.nested.private_key).toBe('[REDACTED]')
		expect(redacted.nested.signature).toBe('[REDACTED]')
		expect(redacted.nested.jwt).toBe('[REDACTED]')
		expect(redacted.nested.bearer).toBe('[REDACTED]')
		expect(redacted.nested.credential).toBe('[REDACTED]')
		expect(redacted.nested.password).toBe('[REDACTED]')
		expect(redacted.nested.authorizationHeader).toBe('[REDACTED]')
		expect(redacted.nested.sessionCookie).toBe('[REDACTED]')
		expect(redacted.nested.menuName).toBe('Lunch')
		expect(redacted.items).toEqual([{ token: '[REDACTED]', id: 'item-1' }])
	})

	it('strips Bearer tokens, JWTs, query params, headers, and provider secrets from text', () => {
		const jwt =
			'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
		const raw = [
			'Authorization: Bearer sk_live_abc1234567890',
			`Bearer my-raw-oauth-token`,
			`jwt=${jwt}`,
			'https://example.com/oauth/callback?code=authcode123&token=tok456&access_token=at789&client_secret=cs000&key=apikey999&state=safe1',
			'provider token sq0atp-1234567890abcdef EAAA_abcdef1234567890 ghp_1234567890abcdef1234 xoxb-1234567890-abcdef AKIAIOSFODNN7EXAMPLE',
		].join('\n')

		const clean = redactSecretsInText(raw)

		expect(clean).not.toContain('sk_live_abc1234567890')
		expect(clean).not.toContain('my-raw-oauth-token')
		expect(clean).not.toContain(jwt)
		expect(clean).not.toContain('authcode123')
		expect(clean).not.toContain('tok456')
		expect(clean).not.toContain('at789')
		expect(clean).not.toContain('cs000')
		expect(clean).not.toContain('apikey999')
		expect(clean).not.toContain('sq0atp-1234567890abcdef')
		expect(clean).not.toContain('EAAA_abcdef1234567890')
		expect(clean).not.toContain('ghp_1234567890abcdef1234')
		expect(clean).not.toContain('xoxb-1234567890-abcdef')
		expect(clean).not.toContain('AKIAIOSFODNN7EXAMPLE')
		expect(clean).toContain('state=safe1')
		expect(clean).toContain('[REDACTED]')
	})

	it('redacts and trims raw responses to maxChars', () => {
		const payload = {
			access_token: 'secret-token-xyz',
			body: 'x'.repeat(5000),
		}
		const trimmed = trimRawResponse(payload, 4000)
		expect(trimmed).not.toBeNull()
		expect(trimmed!.length).toBeLessThanOrEqual(4000)
		expect(trimmed!.endsWith('...')).toBe(true)
		expect(trimmed).not.toContain('secret-token-xyz')
		expect(trimmed).toContain('[REDACTED]')
		expect(trimRawResponse(null)).toBeNull()
	})

	it('maps errors and raw JSON dumps to short readable operator messages', () => {
		expect(
			toSafeSyncErrorMessage(
				new Error(
					'Upstream failed with Bearer secret-token-123 and ?access_token=abc',
				),
			),
		).toBe(
			'Upstream failed with Bearer [REDACTED] and ?access_token=[REDACTED]',
		)

		expect(
			toSafeSyncErrorMessage(
				Object.assign(
					new Error(
						JSON.stringify({
							error: 'invalid_token',
							access_token: 'raw-secret',
						}),
					),
					{ status: 401 },
				),
			),
		).toBe('Authorization expired. Reconnect and try again.')

		expect(
			toSafeSyncErrorMessage(
				'{"detail":"upstream overloaded","secret":"hidden"}',
			),
		).toBe('Sync failed due to an unexpected provider response.')
	})

	it('redacts and trims IntegrationLog inserts and omits raw responseData from getIntegrationStatus', async () => {
		const manager = IntegrationManager.getInstance()
		const insertChain = queryChain([])
		const valuesSpy = vi.spyOn(insertChain, 'values')
		mockDb.insert.mockImplementationOnce(() => insertChain)

		await manager.logIntegrationActivity(
			'int_1',
			'pos_push',
			'error',
			{
				provider: 'square',
				accessToken: 'secret-123',
				pushed: 0,
			},
			'Failed with Bearer secret-abc',
			{
				token: 'secret-raw-response',
				items: 'y'.repeat(5000),
			},
		)

		expect(valuesSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				integrationId: 'int_1',
				action: 'pos_push',
				status: 'error',
				requestData: JSON.stringify({
					provider: 'square',
					accessToken: '[REDACTED]',
					pushed: 0,
				}),
				errorMessage: 'Failed with Bearer [REDACTED]',
			}),
		)
		const insertedValues = valuesSpy.mock.calls[0]?.[0] as {
			responseData: string
		}
		expect(insertedValues.responseData.length).toBeLessThanOrEqual(4000)
		expect(insertedValues.responseData).not.toContain('secret-raw-response')

		mockDb.select
			.mockImplementationOnce(() =>
				queryChain([
					{
						id: 'int_1',
						organizationId: 'org_1',
						providerName: 'square',
						isActive: true,
						lastSyncAt: new Date(),
						tokenExpiresAt: null,
					},
				]),
			)
			.mockImplementationOnce(() => queryChain([]))
			.mockImplementationOnce(() => queryChain([]))
			.mockImplementationOnce(() =>
				queryChain([
					{
						action: 'pos_push',
						status: 'error',
						requestData: JSON.stringify({
							provider: 'square',
							accessToken: 'leaked-legacy-token',
						}),
						responseData: JSON.stringify({ raw: 'must-never-leak' }),
						errorMessage: 'Bearer leaked-token',
						createdAt: new Date('2026-11-24T00:00:00.000Z'),
					},
				]),
			)

		const status = await manager.getIntegrationStatus('int_1')
		expect(status.recentErrors).toHaveLength(1)
		expect(status.recentErrors[0]).not.toHaveProperty('responseData')
		expect(status.recentErrors[0]?.requestData).toEqual({
			provider: 'square',
			accessToken: '[REDACTED]',
		})
		expect(status.recentErrors[0]?.errorMessage).toBe('Bearer [REDACTED]')
	})

	it('prunes IntegrationLog rows older than retentionDays', async () => {
		const deleteChain = queryChain([{ id: 'old_1' }, { id: 'old_2' }])
		mockDb.delete.mockImplementationOnce(() => deleteChain)

		const result = await pruneOldIntegrationLogs(
			90,
			new Date('2026-11-24T00:00:00.000Z'),
		)

		expect(result).toEqual({ deleted: 2 })
		expect(mockDb.delete).toHaveBeenCalledTimes(1)
	})
})
