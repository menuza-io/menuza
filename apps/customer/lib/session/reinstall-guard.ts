import * as SecureStore from 'expo-secure-store'
import { Platform, Settings } from 'react-native'
import { storedReservationTokenKeys } from '../reservations/token-store'
import { PREFERENCE_KEYS } from '../state/preferences'
import { SESSION_STORAGE_KEY } from './token-storage'

/**
 * Remembers that this install already ran. It must live outside the Keychain:
 * iOS keeps Keychain items when the app is deleted, so a reinstall would
 * otherwise come back signed in with the previous install's tokens.
 */
export type InstallMarker = {
	isMarked(): boolean
	mark(): void
}

export const INSTALL_MARKER_KEY = 'customer.installed'

type SettingsLike = Pick<typeof Settings, 'get' | 'set'>

/**
 * iOS: a flag in the app's user defaults, which the system deletes with the
 * app. Android deletes Keystore-backed items with the app (and they are
 * excluded from backups), so there is nothing to detect there.
 */
export function createInstallMarker(
	platform: string = Platform.OS,
	settings: SettingsLike = Settings,
): InstallMarker {
	if (platform !== 'ios') return { isMarked: () => true, mark: () => {} }
	return {
		isMarked() {
			try {
				return settings.get(INSTALL_MARKER_KEY) === 1
			} catch {
				// Without user defaults a wipe would sign the customer out on every
				// launch; keeping the Keychain is the lesser harm.
				return true
			}
		},
		mark() {
			try {
				settings.set({ [INSTALL_MARKER_KEY]: 1 })
			} catch {
				// Asked again on the next launch.
			}
		},
	}
}

/** Every secure-store item the app writes: the session, preferences and booking codes. */
export async function secureItemKeys(): Promise<string[]> {
	return [
		SESSION_STORAGE_KEY,
		...PREFERENCE_KEYS,
		...(await storedReservationTokenKeys()),
	]
}

async function deleteSecureItems(keys: readonly string[]): Promise<void> {
	await Promise.all(
		keys.map((key) => SecureStore.deleteItemAsync(key).catch(() => undefined)),
	)
}

/**
 * Runs before anything reads the secure store. On the first launch of an
 * install it deletes what an earlier install of the app left in the Keychain,
 * so a reinstall starts signed out and unconnected. `true` when it wiped.
 */
export async function forgetPreviousInstall(
	marker: InstallMarker = createInstallMarker(),
): Promise<boolean> {
	if (marker.isMarked()) return false
	try {
		await deleteSecureItems(await secureItemKeys())
	} finally {
		marker.mark()
	}
	return true
}
