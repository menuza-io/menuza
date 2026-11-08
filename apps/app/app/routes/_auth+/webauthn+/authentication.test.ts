import { db, eq, Passkey, Session } from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestUser } from '#tests/test-utils.ts'
import { action, loader } from './authentication.ts'

vi.mock('@simplewebauthn/server', async (importOriginal) => ({
	...(await importOriginal<typeof import('@simplewebauthn/server')>()),
	verifyAuthenticationResponse: vi.fn().mockResolvedValue({
		verified: true,
		authenticationInfo: { newCounter: 0 },
	}),
}))

const authResponse = {
	id: 'cred-1',
	rawId: 'cred-1',
	response: {
		clientDataJSON: 'x',
		authenticatorData: 'x',
		signature: 'x',
	},
	type: 'public-key',
	clientExtensionResults: {},
}

describe('passkey authentication challenge', () => {
	let userId: string
	beforeEach(async () => {
		const user = await createTestUser()
		userId = user.id
		await db.insert(Passkey).values({
			id: `cred-${user.id}`,
			aaguid: 'a',
			publicKey: Buffer.from([1, 2, 3]),
			userId,
			webauthnUserId: 'w',
			counter: 0,
			deviceType: 'multiDevice',
			backedUp: true,
		})
		authResponse.id = `cred-${user.id}`
		authResponse.rawId = authResponse.id
	})

	async function issue() {
		const res = await loader({
			request: new Request('http://localhost:3000/webauthn/authentication'),
		} as any)
		const setCookie = res.headers.get('Set-Cookie')!
		return setCookie.split(';')[0]!
	}

	function post(cookie: string) {
		return action({
			request: new Request('http://localhost:3000/webauthn/authentication', {
				method: 'POST',
				headers: { Cookie: cookie, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					authResponse,
					remember: false,
					redirectTo: null,
				}),
			}),
		} as any)
	}

	it('accepts a challenge once and rejects a replay', async () => {
		const cookie = await issue()
		const first = await post(cookie)
		expect(first.status).toBe(200)
		const second = await post(cookie)
		expect(second.status).toBe(400)
		const sessions = await db
			.select()
			.from(Session)
			.where(eq(Session.userId, userId))
		expect(sessions).toHaveLength(1)
	})
})
