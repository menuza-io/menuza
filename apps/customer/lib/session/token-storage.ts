import * as SecureStore from 'expo-secure-store'
import { type AuthTokens, parseStoredTokens } from './auth-tokens'

/**
 * Where the customer's tenant-api tokens live. The website keeps them in
 * localStorage so a US Sites render never touches KSA data; the app keeps them
 * in the Keychain or the Android Keystore, never in the control plane.
 */
export type TokenStorage = {
	load(): Promise<AuthTokens | null>
	/** `false` when the tokens could not be persisted; the in-memory session goes on either way. */
	save(tokens: AuthTokens | null): Promise<boolean>
}

export const SESSION_STORAGE_KEY = 'customer-session'

export function createSecureTokenStorage(
	key: string = SESSION_STORAGE_KEY,
): TokenStorage {
	return {
		async load() {
			try {
				const raw = await SecureStore.getItemAsync(key)
				return raw ? parseStoredTokens(raw) : null
			} catch {
				return null
			}
		},
		async save(tokens) {
			try {
				if (!tokens) {
					await SecureStore.deleteItemAsync(key)
					return true
				}
				await SecureStore.setItemAsync(key, JSON.stringify(tokens), {
					// Never migrated to another device by a backup restore.
					keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
				})
				return true
			} catch {
				return false
			}
		},
	}
}

export function createMemoryTokenStorage(
	initial: AuthTokens | null = null,
): TokenStorage & {
	readonly current: AuthTokens | null
} {
	let tokens = initial
	return {
		get current() {
			return tokens
		},
		async load() {
			return tokens
		},
		async save(next) {
			tokens = next
			return true
		},
	}
}
