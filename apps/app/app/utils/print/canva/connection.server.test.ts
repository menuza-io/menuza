import { db, eq, PrintCanvaConnection } from '@repo/database'
import { decryptAsync, getEncryptionKey } from '@repo/security'
import { describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

const client = vi.hoisted(() => ({
	refreshCanvaTokens: vi.fn(),
	revokeCanvaToken: vi.fn(async () => {}),
	tokensSeen: [] as string[],
}))

vi.mock('./client.server.ts', async (importOriginal) => {
	return {
		...(await importOriginal<Record<string, unknown>>()),
		refreshCanvaTokens: client.refreshCanvaTokens,
		revokeCanvaToken: client.revokeCanvaToken,
		canvaApi: (token: string) => {
			client.tokensSeen.push(token)
			return { token }
		},
	}
})

const { CanvaError } = await import('./errors.ts')
const {
	deleteCanvaConnection,
	getCanvaConnection,
	saveCanvaConnection,
	withCanva,
} = await import('./connection.server.ts')

const key = () => getEncryptionKey('INTEGRATION_ENCRYPTION_KEY')

function tokens(name: string, expiresInMs = 3_600_000) {
	return {
		accessToken: `access-${name}`,
		refreshToken: `refresh-${name}`,
		expiresAt: new Date(Date.now() + expiresInMs),
		scope: 'design:meta:read',
	}
}

async function owner() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id)
	return { userId: user.id, organization: { id: organization.id } }
}

describe('Canva connections', () => {
	it('stores tokens encrypted, one connection per member', async () => {
		const member = await owner()
		await saveCanvaConnection(member, tokens('a'), {
			userId: 'cu',
			displayName: 'Dana',
		})
		await saveCanvaConnection(member, tokens('b'), {
			userId: 'cu',
			displayName: 'Dana',
		})
		const rows = await db.select().from(PrintCanvaConnection)
		const mine = rows.filter((row) => row.userId === member.userId)
		expect(mine).toHaveLength(1)
		expect(mine[0]!.accessToken).not.toContain('access-b')
		expect(await decryptAsync(mine[0]!.accessToken, key())).toBe('access-b')
		expect(await getCanvaConnection(member)).toMatchObject({
			displayName: 'Dana',
		})
	})

	it('refreshes an expiring token first and keeps the new refresh token', async () => {
		const member = await owner()
		await saveCanvaConnection(member, tokens('old', 30_000), {
			userId: null,
			displayName: null,
		})
		client.refreshCanvaTokens.mockResolvedValueOnce(tokens('new'))
		const used = await withCanva(member, async (api) => api)
		expect(used).toEqual({ token: 'access-new' })
		expect(client.refreshCanvaTokens).toHaveBeenLastCalledWith('refresh-old')
		const [row] = await db
			.select()
			.from(PrintCanvaConnection)
			.where(eq(PrintCanvaConnection.userId, member.userId))
		expect(await decryptAsync(row!.refreshToken, key())).toBe('refresh-new')
	})

	it('retries once with a refreshed token when Canva refuses the access token', async () => {
		const member = await owner()
		await saveCanvaConnection(member, tokens('one'), {
			userId: null,
			displayName: null,
		})
		client.refreshCanvaTokens.mockResolvedValueOnce(tokens('two'))
		let calls = 0
		const result = await withCanva(member, async (api) => {
			calls += 1
			if (calls === 1) throw new CanvaError('unauthorized', 'expired', 401)
			return (api as unknown as { token: string }).token
		})
		expect(result).toBe('access-two')
	})

	it('forgets the connection when the grant is gone', async () => {
		const member = await owner()
		await saveCanvaConnection(member, tokens('gone', 1_000), {
			userId: null,
			displayName: null,
		})
		client.refreshCanvaTokens.mockRejectedValueOnce(
			new CanvaError('invalid_grant', 'invalid_grant', 400),
		)
		await expect(withCanva(member, async () => 'never')).rejects.toMatchObject({
			code: 'unauthorized',
		})
		expect(await getCanvaConnection(member)).toBeNull()
	})

	it('keeps the connection through a passing Canva error', async () => {
		const member = await owner()
		await saveCanvaConnection(member, tokens('keep', 1_000), {
			userId: null,
			displayName: null,
		})
		client.refreshCanvaTokens.mockRejectedValueOnce(
			new CanvaError('unavailable', 'Canva token request failed (401)', 401),
		)
		await expect(withCanva(member, async () => 'never')).rejects.toMatchObject({
			code: 'unavailable',
		})
		expect(await getCanvaConnection(member)).not.toBeNull()
	})

	it('does not run work twice that is not idempotent', async () => {
		const member = await owner()
		await saveCanvaConnection(member, tokens('once'), {
			userId: null,
			displayName: null,
		})
		client.refreshCanvaTokens.mockResolvedValueOnce(tokens('twice'))
		let calls = 0
		await expect(
			withCanva(
				member,
				async () => {
					calls += 1
					throw new CanvaError('unauthorized', 'expired', 401)
				},
				{ idempotent: false },
			),
		).rejects.toMatchObject({ code: 'unavailable' })
		expect(calls).toBe(1)
		// The refreshed token is kept for the member's next try.
		const [row] = await db
			.select()
			.from(PrintCanvaConnection)
			.where(eq(PrintCanvaConnection.userId, member.userId))
		expect(await decryptAsync(row!.refreshToken, key())).toBe('refresh-twice')
	})

	it('uses the token a concurrent refresh stored instead of failing', async () => {
		const member = await owner()
		await saveCanvaConnection(member, tokens('first', 1_000), {
			userId: null,
			displayName: null,
		})
		// Another request refreshes while ours is on the wire; Canva then
		// refuses our (now spent) refresh token.
		client.refreshCanvaTokens.mockImplementationOnce(async () => {
			await saveCanvaConnection(member, tokens('winner'), {
				userId: null,
				displayName: null,
			})
			throw new CanvaError('invalid_grant', 'invalid_grant', 400)
		})
		const used = await withCanva(member, async (api) => api)
		expect(used).toEqual({ token: 'access-winner' })
		expect(await getCanvaConnection(member)).not.toBeNull()
	})

	it('disconnects: forgets the tokens and revokes the grant', async () => {
		const member = await owner()
		await saveCanvaConnection(member, tokens('bye'), {
			userId: null,
			displayName: null,
		})
		await deleteCanvaConnection(member)
		expect(await getCanvaConnection(member)).toBeNull()
		expect(client.revokeCanvaToken).toHaveBeenLastCalledWith('refresh-bye')
	})
})
