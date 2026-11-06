import { BackupCode, db } from '@repo/database'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	enableTwoFactor,
} from '#tests/test-utils.ts'
import { action } from './security.tsx'

// A session cookie alone (no TOTP, no existing backup code) must not be able
// to mint backup codes once the last 2FA verification is stale, because those
// codes satisfy both the 2FA step-up and disable-2FA.
async function staleSessionAction(intent: string) {
	const user = await createTestUser()
	await enableTwoFactor(user.id)
	const { cookie } = await createTestSession(user.id)
	const body = new FormData()
	body.set('intent', intent)
	const request = createAuthenticatedRequest(
		'http://localhost:3000/security',
		{ method: 'POST', body },
		cookie,
	)
	let result: unknown
	try {
		result = await action({ request } as never)
	} catch (error) {
		result = error
	}
	return { user, result }
}

describe('backup code generation requires step-up', () => {
	it.each(['generate-backup-codes', 'regenerate-backup-codes'])(
		'%s redirects to re-verify when verification is stale',
		async (intent) => {
			const { result } = await staleSessionAction(intent)
			expect(result).toBeInstanceOf(Response)
			const response = result as Response
			expect(response.status).toBe(302)
			expect(
				new URL(response.headers.get('Location')!, 'http://x').pathname,
			).toBe('/verify')
		},
	)

	it('does not create backup codes while stale', async () => {
		const { user } = await staleSessionAction('generate-backup-codes')
		const rows = await db
			.select({ id: BackupCode.id })
			.from(BackupCode)
			.where(eq(BackupCode.userId, user.id))
		expect(rows).toHaveLength(0)
	})
})
