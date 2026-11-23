import { randomUUID } from 'node:crypto'
import { AuditAction, auditService } from '@repo/audit'
import { Feedback, Organization, User, db } from '@repo/database'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { lookupRequest } from './request-lookup.server.ts'

const config = { apiToken: 'token-123456', sourceId: '7' }
const TRACE = 'a1b2c3d4e5f6a7b8'

let log: MockInstance<typeof auditService.log>
beforeEach(() => {
	vi.restoreAllMocks()
	log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
})

async function agent() {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com`, name: 'Sara Support' })
		.returning()
	return user!
}

describe('Request lookup (#385)', () => {
	it('finds the log lines of a request from its reference id, with a faked log client', async () => {
		const support = await agent()
		const fetchImpl = vi.fn(async () =>
			Response.json({
				data: [
					{
						dt: '2026-11-23T10:00:00Z',
						json: {
							traceId: TRACE,
							level: 'error',
							message: 'Request failed',
							method: 'POST',
							path: '/acme/orders',
							statusCode: 500,
						},
					},
				],
			}),
		) as unknown as typeof fetch

		const result = await lookupRequest({
			agentId: support.id,
			traceId: TRACE,
			config,
			fetchImpl,
		})
		expect(result.logs.status).toBe('ok')
		if (result.logs.status !== 'ok') return
		expect(result.logs.hits[0]).toMatchObject({
			path: '/acme/orders',
			statusCode: 500,
		})
		// Audited with the support member's name; the id holds nothing personal.
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.ADMIN_REQUEST_LOOKUP,
				userId: support.id,
				metadata: expect.objectContaining({
					agentName: 'Sara Support',
					traceId: TRACE,
				}),
			}),
		)
	})

	it('links the support request that came with the same reference', async () => {
		const support = await agent()
		const member = await agent()
		const id = randomUUID()
		const [organization] = await db
			.insert(Organization)
			.values({ name: `Business ${id.slice(0, 6)}`, slug: `org-${id}` })
			.returning()
		const trace = 'b1b2c3d4e5f6a7b8'
		const [request] = await db
			.insert(Feedback)
			.values({
				userId: member.id,
				organizationId: organization!.id,
				kind: 'problem',
				type: 'PROBLEM',
				message: 'It broke',
				errorId: trace,
			})
			.returning()
		const result = await lookupRequest({
			agentId: support.id,
			traceId: trace.toUpperCase(),
			config: {},
			fetchImpl: vi.fn() as unknown as typeof fetch,
		})
		expect(result.logs.status).toBe('not_configured')
		expect(result.requests.map((row) => row.id)).toEqual([request!.id])
	})

	it('never sends a malformed reference to the provider', async () => {
		const support = await agent()
		const fetchImpl = vi.fn() as unknown as typeof fetch
		const result = await lookupRequest({
			agentId: support.id,
			traceId: 'x" OR 1=1',
			config,
			fetchImpl,
		})
		expect(result.logs.status).toBe('invalid_id')
		expect(fetchImpl).not.toHaveBeenCalled()
	})
})
