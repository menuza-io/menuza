import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db, Password } from '@repo/database'
import { createTestUser } from '#tests/test-utils.ts'
import { changePasswordAction, setPasswordAction } from './security.actions.ts'

describe('changePasswordAction current-password rate limit', () => {
	it('refuses further guesses after too many wrong current passwords', async () => {
		const user = await createTestUser({ password: 'CorrectPassword123!' })
		const statuses: number[] = []
		for (let attempt = 0; attempt < 9; attempt++) {
			const formData = new FormData()
			formData.append('currentPassword', `Wrong-guess-${attempt}-Pw!`)
			formData.append('newPassword', 'Brand-new-Secret-Pw-4821!')
			formData.append('confirmNewPassword', 'Brand-new-Secret-Pw-4821!')
			const response = await changePasswordAction({
				userId: user.id,
				formData,
			})
			statuses.push(response.status)
		}
		expect(statuses.slice(0, 8)).toEqual(Array(8).fill(400))
		expect(statuses[8]).toBe(429)
	})
})

describe('setPasswordAction double submit', () => {
	it('sets the password once and refuses the second submit without throwing', async () => {
		const user = await createTestUser()
		await db.delete(Password).where(eq(Password.userId, user.id))
		const submit = () => {
			const formData = new FormData()
			formData.append('password', 'Brand-new-Secret-Pw-4821!')
			formData.append('confirmPassword', 'Brand-new-Secret-Pw-4821!')
			return setPasswordAction({ userId: user.id, formData })
		}
		expect((await submit()).status).toBe(200)
		const second = await submit()
		expect(second.status).toBe(400)
		const rows = await db
			.select()
			.from(Password)
			.where(eq(Password.userId, user.id))
		expect(rows).toHaveLength(1)
	})
})
