import AsyncStorage from '@react-native-async-storage/async-storage'
import { registerPushDevice, removePushDevice, type PushApi } from '../api/push'

/**
 * Registers this phone for operator push (#106) and wires a tap on a push to the
 * right place. Everything the platform provides (permission, the Expo token,
 * the tap listener) comes in through `PushPlatform`, so it is testable and a
 * build without the native module (needs a rebuild) simply reports
 * `unavailable` and the app carries on.
 *
 * The push itself carries a kind, a place, an order number and a link: never a
 * guest. The link is checked before it is opened.
 */

export interface PushPlatform {
	os: 'ios' | 'android' | 'other'
	locale: string
	deviceName?: string
	appVersion?: string
	/** The EAS project id the Expo push token is minted for. */
	projectId?: string
	getPermission(): Promise<'granted' | 'denied' | 'undetermined'>
	requestPermission(): Promise<'granted' | 'denied' | 'undetermined'>
	getToken(projectId?: string): Promise<string>
}

export type RegisterResult =
	| { status: 'registered'; token: string; deviceId: string }
	| { status: 'denied' | 'unavailable' | 'failed' }

const TOKEN_KEY = 'operatorPush.token'
const DEVICE_KEY = 'operatorPush.deviceId'

export async function storedPushToken(
	storage = AsyncStorage,
): Promise<string | null> {
	return storage.getItem(TOKEN_KEY)
}

export async function storedPushDeviceId(
	storage = AsyncStorage,
): Promise<string | null> {
	return storage.getItem(DEVICE_KEY)
}

/**
 * After sign-in: asks for permission (the system shows its own question once),
 * gets the token and registers it for the signed-in member. Re-registering is
 * safe (the token is unique, signing in as someone else on this phone moves it).
 */
export async function registerThisDevice(input: {
	platform: PushPlatform
	api?: PushApi
	storage?: typeof AsyncStorage
}): Promise<RegisterResult> {
	const { platform } = input
	const storage = input.storage ?? AsyncStorage
	if (platform.os === 'other') return { status: 'unavailable' }
	try {
		let permission = await platform.getPermission()
		if (permission === 'undetermined') {
			permission = await platform.requestPermission()
		}
		if (permission !== 'granted') return { status: 'denied' }
		const token = await platform.getToken(platform.projectId)
		const registered = await registerPushDevice(
			{
				token,
				platform: platform.os,
				locale: platform.locale,
				deviceName: platform.deviceName,
				appVersion: platform.appVersion,
			},
			input.api,
		)
		if (!registered.ok) return { status: 'failed' }
		await storage.setItem(TOKEN_KEY, token)
		await storage.setItem(DEVICE_KEY, registered.data.deviceId)
		return {
			status: 'registered',
			token,
			deviceId: registered.data.deviceId,
		}
	} catch {
		return { status: 'unavailable' }
	}
}

/**
 * Before signing out: removes this phone for the signed-in member, so nothing is
 * pushed to it afterwards. Best effort: a failure still signs out, and the
 * server stops pushing to a member who loses access anyway.
 */
export async function unregisterThisDevice(input: {
	api?: PushApi
	storage?: typeof AsyncStorage
}): Promise<boolean> {
	const storage = input.storage ?? AsyncStorage
	const token = await storage.getItem(TOKEN_KEY)
	if (!token) return false
	try {
		const result = await removePushDevice({ token }, input.api)
		await storage.removeItem(TOKEN_KEY)
		await storage.removeItem(DEVICE_KEY)
		return result.ok
	} catch {
		return false
	}
}

export type PushTarget = { kind: 'url'; url: string } | { kind: 'none' }

/**
 * Where a tap on a push goes. Orders, tablets, staff, inventory and reservations
 * have no screen on the phone yet, so the push carries the App's address and a
 * tap opens it; the address is only opened when it is on the App's own origin.
 */
export function pushTarget(
	data: unknown,
	appOrigin: string | null | undefined,
): PushTarget {
	if (!data || typeof data !== 'object') return { kind: 'none' }
	const raw = (data as { url?: unknown }).url
	if (typeof raw !== 'string' || !appOrigin) return { kind: 'none' }
	try {
		const url = new URL(raw)
		const origin = new URL(appOrigin)
		if (
			url.origin === origin.origin &&
			(url.protocol === 'https:' ||
				(url.protocol === 'http:' &&
					(url.hostname === 'localhost' || url.hostname.endsWith('.test'))))
		) {
			return { kind: 'url', url: url.toString() }
		}
	} catch {
		// Not a link.
	}
	return { kind: 'none' }
}
