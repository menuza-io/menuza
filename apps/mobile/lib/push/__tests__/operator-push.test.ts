import { type PushApi } from '../../api/push'
import {
	pushTarget,
	registerThisDevice,
	unregisterThisDevice,
	type PushPlatform,
} from '../operator-push'

function memoryStorage() {
	const map = new Map<string, string>()
	return {
		getItem: jest.fn(async (key: string) => map.get(key) ?? null),
		setItem: jest.fn(async (key: string, value: string) => {
			map.set(key, value)
		}),
		removeItem: jest.fn(async (key: string) => {
			map.delete(key)
		}),
		map,
	} as never as typeof import('@react-native-async-storage/async-storage').default & {
		map: Map<string, string>
	}
}

function platform(overrides: Partial<PushPlatform> = {}): PushPlatform {
	return {
		os: 'ios',
		locale: 'en-US',
		deviceName: 'iPhone',
		appVersion: '1.0.0',
		getPermission: async () => 'granted',
		requestPermission: async () => 'granted',
		getToken: async () => 'ExponentPushToken[abcdefgh12345678]',
		...overrides,
	}
}

function api(overrides: Partial<PushApi> = {}): PushApi {
	return {
		authenticatedGet: jest.fn(),
		authenticatedSend: jest.fn(async () => ({
			success: true,
			status: 200,
			data: { deviceId: 'dev_1', removed: 1 },
		})),
		...overrides,
	} as never
}

describe('registerThisDevice', () => {
	it('asks once, gets the token and registers it for the signed-in member', async () => {
		const storage = memoryStorage()
		const requestPermission = jest.fn(async () => 'granted' as const)
		const client = api()
		const result = await registerThisDevice({
			platform: platform({
				getPermission: async () => 'undetermined',
				requestPermission,
			}),
			api: client,
			storage,
		})
		expect(result).toEqual({
			status: 'registered',
			token: 'ExponentPushToken[abcdefgh12345678]',
			deviceId: 'dev_1',
		})
		expect(requestPermission).toHaveBeenCalledTimes(1)
		expect(client.authenticatedSend).toHaveBeenCalledWith(
			'POST',
			'/api/push/devices',
			{
				token: 'ExponentPushToken[abcdefgh12345678]',
				platform: 'ios',
				locale: 'en-US',
				deviceName: 'iPhone',
				appVersion: '1.0.0',
			},
		)
		expect(storage.map.get('operatorPush.token')).toBe(
			'ExponentPushToken[abcdefgh12345678]',
		)
	})

	it('does not ask again once permission was already given, and does nothing when denied', async () => {
		const requestPermission = jest.fn(async () => 'granted' as const)
		await registerThisDevice({
			platform: platform({ requestPermission }),
			api: api(),
			storage: memoryStorage(),
		})
		expect(requestPermission).not.toHaveBeenCalled()
		const client = api()
		expect(
			await registerThisDevice({
				platform: platform({
					getPermission: async () => 'denied',
				}),
				api: client,
				storage: memoryStorage(),
			}),
		).toEqual({ status: 'denied' })
		expect(client.authenticatedSend).not.toHaveBeenCalled()
	})

	it('reports a refusal from the server, an unsupported platform and a missing native module', async () => {
		expect(
			await registerThisDevice({
				platform: platform(),
				api: api({
					authenticatedSend: jest.fn(async () => ({
						success: false,
						status: 400,
						error: 'validation_error',
					})),
				} as never),
				storage: memoryStorage(),
			}),
		).toEqual({ status: 'failed' })
		expect(
			await registerThisDevice({
				platform: platform({ os: 'other' }),
				storage: memoryStorage(),
			}),
		).toEqual({ status: 'unavailable' })
		expect(
			await registerThisDevice({
				platform: platform({
					getToken: async () => {
						throw new Error('native module missing')
					},
				}),
				api: api(),
				storage: memoryStorage(),
			}),
		).toEqual({ status: 'unavailable' })
	})
})

describe('unregisterThisDevice', () => {
	it('removes this phone by its token when signing out, and forgets it', async () => {
		const storage = memoryStorage()
		await storage.setItem(
			'operatorPush.token',
			'ExponentPushToken[abcdefgh12345678]',
		)
		const client = api()
		expect(await unregisterThisDevice({ api: client, storage })).toBe(true)
		expect(client.authenticatedSend).toHaveBeenCalledWith(
			'DELETE',
			'/api/push/devices',
			{
				token: 'ExponentPushToken[abcdefgh12345678]',
			},
		)
		expect(storage.map.has('operatorPush.token')).toBe(false)
	})

	it('does nothing for a phone that never registered, and never throws', async () => {
		const client = api()
		expect(
			await unregisterThisDevice({ api: client, storage: memoryStorage() }),
		).toBe(false)
		expect(client.authenticatedSend).not.toHaveBeenCalled()
		const storage = memoryStorage()
		await storage.setItem(
			'operatorPush.token',
			'ExponentPushToken[abcdefgh12345678]',
		)
		expect(
			await unregisterThisDevice({
				api: api({
					authenticatedSend: jest.fn(async () => {
						throw new Error('offline')
					}),
				} as never),
				storage,
			}),
		).toBe(false)
	})
})

describe('pushTarget', () => {
	const origin = 'https://app.menuza.io'

	it('opens the App link a push carries, when it is on the App origin', () => {
		expect(
			pushTarget(
				{ kind: 'orders-new', url: 'https://app.menuza.io/acme/orders' },
				origin,
			),
		).toEqual({ kind: 'url', url: 'https://app.menuza.io/acme/orders' })
	})

	it('never opens a link elsewhere, a non-link, or anything without an App origin', () => {
		for (const data of [
			{ url: 'https://evil.example/acme/orders' },
			{ url: 'javascript:alert(1)' },
			{ url: 'https://app.menuza.io.evil.example/x' },
			{ url: 42 },
			{},
			null,
			'orders',
		]) {
			expect(pushTarget(data, origin)).toEqual({ kind: 'none' })
		}
		expect(pushTarget({ url: 'https://app.menuza.io/x' }, null)).toEqual({
			kind: 'none',
		})
	})
})
