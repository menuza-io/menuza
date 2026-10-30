import * as SecureStore from 'expo-secure-store'
import { createSecureTokenStorage, SESSION_STORAGE_KEY } from './token-storage'

describe('createSecureTokenStorage', () => {
	it('round-trips tokens through the secure store', async () => {
		const storage = createSecureTokenStorage()

		expect(await storage.load()).toBeNull()
		expect(
			await storage.save({
				accessToken: 'access-1',
				refreshToken: 'refresh-1',
			}),
		).toBe(true)
		expect(await storage.load()).toEqual({
			accessToken: 'access-1',
			refreshToken: 'refresh-1',
		})
		expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
			SESSION_STORAGE_KEY,
			expect.any(String),
			// THIS_DEVICE_ONLY: a backup restored onto another device carries no session.
			{ keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY },
		)

		expect(await storage.save(null)).toBe(true)
		expect(await storage.load()).toBeNull()
	})

	it('ignores unreadable stored values', async () => {
		await SecureStore.setItemAsync(SESSION_STORAGE_KEY, 'not json')
		expect(await createSecureTokenStorage().load()).toBeNull()

		await SecureStore.setItemAsync(SESSION_STORAGE_KEY, '{"accessToken":""}')
		expect(await createSecureTokenStorage().load()).toBeNull()

		// A stored session without a refresh token cannot be renewed: no session.
		await SecureStore.setItemAsync(SESSION_STORAGE_KEY, '{"accessToken":"a"}')
		expect(await createSecureTokenStorage().load()).toBeNull()
	})

	it('reports a failed write instead of throwing', async () => {
		jest
			.mocked(SecureStore.setItemAsync)
			.mockRejectedValueOnce(new Error('keychain'))
		expect(
			await createSecureTokenStorage().save({
				accessToken: 'a',
				refreshToken: 'r',
			}),
		).toBe(false)
	})
})
