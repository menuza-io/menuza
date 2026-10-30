import * as SecureStore from 'expo-secure-store'
import {
	createInstallMarker,
	forgetPreviousInstall,
	INSTALL_MARKER_KEY,
	type InstallMarker,
} from './reinstall-guard'
import { createSecureTokenStorage, SESSION_STORAGE_KEY } from './token-storage'
import {
	createSecureReservationTokenStore,
	RESERVATION_TOKENS_KEY,
	reservationTokensKey,
} from '@/lib/reservations/token-store'
import { createSecurePreferences } from '@/lib/state/preferences'
import { makeSiteAddress } from '@/lib/support/site-address'

function memoryMarker(marked = false): InstallMarker & { marked: boolean } {
	const marker = {
		marked,
		isMarked: () => marker.marked,
		mark: () => {
			marker.marked = true
		},
	}
	return marker
}

async function seedPreviousInstall() {
	await createSecureTokenStorage().save({
		accessToken: 'access-old',
		refreshToken: 'refresh-old',
	})
	const preferences = createSecurePreferences()
	await preferences.saveSiteAddress(makeSiteAddress({ slug: 'acme' }))
	await preferences.saveLanguageOverride('ar')
	await createSecureReservationTokenStore('org_1').rememberManage(
		'rsv_1',
		'tok_a',
	)
	await SecureStore.setItemAsync(RESERVATION_TOKENS_KEY, '{"manage":{}}')
}

describe('forgetPreviousInstall', () => {
	it('starts a reinstall signed out and unconnected', async () => {
		await seedPreviousInstall()
		const marker = memoryMarker(false)

		expect(await forgetPreviousInstall(marker)).toBe(true)

		expect(await createSecureTokenStorage().load()).toBeNull()
		expect(await SecureStore.getItemAsync(SESSION_STORAGE_KEY)).toBeNull()
		const preferences = createSecurePreferences()
		expect(await preferences.loadSiteAddress()).toBeNull()
		expect(await preferences.loadLanguageOverride()).toBeNull()
		expect(
			await SecureStore.getItemAsync(reservationTokensKey('org_1')),
		).toBeNull()
		expect(await SecureStore.getItemAsync(RESERVATION_TOKENS_KEY)).toBeNull()
		expect(marker.marked).toBe(true)
	})

	it('keeps everything once this install has run', async () => {
		await seedPreviousInstall()

		expect(await forgetPreviousInstall(memoryMarker(true))).toBe(false)

		expect((await createSecureTokenStorage().load())?.refreshToken).toBe(
			'refresh-old',
		)
		expect(await createSecurePreferences().loadSiteAddress()).not.toBeNull()
		expect(
			(await createSecureReservationTokenStore('org_1').load()).manage,
		).toEqual({ rsv_1: 'tok_a' })
	})

	it('marks the install even when a delete fails', async () => {
		await seedPreviousInstall()
		jest
			.mocked(SecureStore.deleteItemAsync)
			.mockRejectedValueOnce(new Error('keychain'))
		const marker = memoryMarker(false)

		await forgetPreviousInstall(marker)

		expect(marker.marked).toBe(true)
	})
})

describe('createInstallMarker', () => {
	it('keeps the marker in iOS user defaults, which are deleted with the app', () => {
		const values: Record<string, unknown> = {}
		const settings = {
			get: (key: string) => values[key],
			set: (next: Record<string, unknown>) => Object.assign(values, next),
		}
		const marker = createInstallMarker('ios', settings)

		expect(marker.isMarked()).toBe(false)
		marker.mark()
		expect(values[INSTALL_MARKER_KEY]).toBe(1)
		expect(marker.isMarked()).toBe(true)
	})

	it('never wipes when user defaults cannot be read', () => {
		const settings = {
			get: () => {
				throw new Error('no native module')
			},
			set: () => {
				throw new Error('no native module')
			},
		}
		const marker = createInstallMarker('ios', settings)

		expect(marker.isMarked()).toBe(true)
		expect(() => marker.mark()).not.toThrow()
	})

	it('has nothing to detect on Android, which deletes Keystore items with the app', () => {
		const settings = { get: jest.fn(), set: jest.fn() }
		const marker = createInstallMarker('android', settings)

		expect(marker.isMarked()).toBe(true)
		marker.mark()
		expect(settings.get).not.toHaveBeenCalled()
		expect(settings.set).not.toHaveBeenCalled()
	})
})
