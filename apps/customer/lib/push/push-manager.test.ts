import { memoryDeviceStore } from './device-store'
import { PushManager } from './push-manager'
import { makeSignedInSession } from '@/test/loyalty/session'
import { fakeNotifications } from '@/test/push-fake'
import { StubTransport } from '@/test/stub-transport'

const PREFS = {
	orders: true,
	bookings: true,
	rewards: true,
	marketing: false,
	hasDevice: false,
	marketingAvailable: true,
}

async function setup(
	handler: (request: { method: string; path: string }) => {
		status?: number
		json?: unknown
		raw?: string
	},
	notifications = fakeNotifications(),
) {
	const transport = new StubTransport((request) =>
		handler({ method: request.method, path: new URL(request.url).pathname }),
	)
	const devices = memoryDeviceStore()
	const session = await makeSignedInSession(transport.send)
	const manager = new PushManager({
		session,
		language: () => 'ar',
		devices,
		adapter: () => notifications.adapter,
		platform: 'android',
	})
	return { transport, devices, manager, notifications }
}

const registerAndPrefs = (request: { method: string; path: string }) => {
	if (request.path === '/push/devices')
		return { status: 201, json: { id: 'dev_1', dropped: 0 } }
	if (request.path === '/push/preferences')
		return { json: { ...PREFS, hasDevice: true } }
	return { status: 204, raw: '' }
}

describe('PushManager (#105)', () => {
	it('is unavailable when the region says push is not enabled', async () => {
		const { manager } = await setup(() => ({
			status: 409,
			json: { error: 'push_not_enabled' },
		}))
		expect(await manager.state()).toEqual({ kind: 'unavailable' })
	})

	it('asks the system only when the guest turns notifications on, then registers the device', async () => {
		const { manager, transport, devices, notifications } =
			await setup(registerAndPrefs)
		expect(await manager.state()).toMatchObject({
			kind: 'ready',
			permission: 'undetermined',
		})
		expect(notifications.state.prompts).toBe(0)

		const result = await manager.enable()
		expect(result.kind).toBe('enabled')
		expect(notifications.state.prompts).toBe(1)
		const registered = transport.recorded.find(
			(r) => r.url.pathname === '/push/devices',
		)!
		expect(registered.body).toEqual({
			token: 'ExponentPushToken[abcdefghijklmnop]',
			platform: 'android',
			locale: 'ar',
		})
		expect(await devices.read('org_1')).toBe('dev_1')
	})

	it('records the offers opt-in from the pre-prompt with the app_prompt source, off unless chosen', async () => {
		const plain = await setup(registerAndPrefs)
		await plain.manager.enable()
		const put = plain.transport.recorded.find(
			(r) => r.request.method === 'PUT',
		)!
		expect(put.body).toEqual({})

		const offers = await setup(registerAndPrefs)
		await offers.manager.enable({ marketing: true })
		const optIn = offers.transport.recorded.find(
			(r) => r.request.method === 'PUT',
		)!
		expect(optIn.body).toEqual({ marketing: true, source: 'app_prompt' })
	})

	it('registers nothing when the system says no', async () => {
		const { manager, transport } = await setup(
			registerAndPrefs,
			fakeNotifications({ answer: 'denied' }),
		)
		expect((await manager.enable()).kind).toBe('denied')
		expect(
			transport.recorded.some((r) => r.url.pathname === '/push/devices'),
		).toBe(false)
	})

	it('registers nothing when there is no push token (simulator)', async () => {
		const { manager, transport } = await setup(
			registerAndPrefs,
			fakeNotifications({ token: null }),
		)
		expect((await manager.enable()).kind).toBe('no_token')
		expect(
			transport.recorded.some((r) => r.url.pathname === '/push/devices'),
		).toBe(false)
	})

	it('sync registers again only when the system already allows notifications, and never prompts', async () => {
		const off = await setup(
			registerAndPrefs,
			fakeNotifications({ permission: 'undetermined' }),
		)
		await off.manager.sync()
		expect(off.notifications.state.prompts).toBe(0)
		expect(
			off.transport.recorded.some((r) => r.url.pathname === '/push/devices'),
		).toBe(false)

		const on = await setup(
			registerAndPrefs,
			fakeNotifications({ permission: 'granted' }),
		)
		await on.manager.sync()
		expect(
			on.transport.recorded.some((r) => r.url.pathname === '/push/devices'),
		).toBe(true)
		expect(on.notifications.state.prompts).toBe(0)
	})

	it('sign-out deletes this device on the server and forgets its id', async () => {
		const { manager, transport, devices } = await setup(
			registerAndPrefs,
			fakeNotifications({ permission: 'granted' }),
		)
		await manager.enable()
		await manager.unregister()
		const removed = transport.recorded.find(
			(r) => r.request.method === 'DELETE',
		)!
		expect(removed.url.pathname).toBe('/push/devices/dev_1')
		expect(await devices.read('org_1')).toBeNull()
	})

	it('sign-out forgets the device id even when the server cannot be reached', async () => {
		let down = false
		const { manager, devices } = await setup((request) =>
			down && request.method === 'DELETE'
				? { status: 500, json: {} }
				: registerAndPrefs(request),
		)
		await manager.enable()
		down = true
		await expect(manager.unregister()).resolves.toBeUndefined()
		expect(await devices.read('org_1')).toBeNull()
	})
})
