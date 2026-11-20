import { ApiError } from '@/lib/api/api-error'
import { PushClient } from '@/lib/api/push'
import { makeSignedInSession } from '@/test/loyalty/session'
import { StubTransport } from '@/test/stub-transport'

async function setup(transport: StubTransport) {
	return new PushClient(await makeSignedInSession(transport.send))
}

const PREFS = {
	orders: true,
	bookings: true,
	rewards: false,
	marketing: false,
	hasDevice: true,
	marketingAvailable: true,
}

describe('PushClient (#105)', () => {
	it('reads the guest preferences with the customer token', async () => {
		const transport = new StubTransport([{ json: PREFS }])
		expect(await (await setup(transport)).preferences()).toEqual(PREFS)
		const sent = transport.recorded[0]!
		expect(sent.request.method).toBe('GET')
		expect(sent.url.pathname).toBe('/push/preferences')
		expect(sent.request.headers.Authorization).toMatch(/^Bearer /)
	})

	it('answers null when push is not on for the restaurant (409 push_not_enabled)', async () => {
		const transport = new StubTransport([
			{ status: 409, json: { error: 'push_not_enabled' } },
		])
		expect(await (await setup(transport)).preferences()).toBeNull()
	})

	it('lets other failures through', async () => {
		const transport = new StubTransport([
			{ status: 500, json: { error: 'boom' } },
		])
		await expect((await setup(transport)).preferences()).rejects.toBeInstanceOf(
			ApiError,
		)
	})

	it('registers a device and returns its id', async () => {
		const transport = new StubTransport([
			{ status: 201, json: { id: 'dev_1', dropped: 0 } },
		])
		const id = await (
			await setup(transport)
		).register({
			token: 'ExponentPushToken[abcdefghijklmnop]',
			platform: 'ios',
			locale: 'ar',
		})
		expect(id).toBe('dev_1')
		const sent = transport.recorded[0]!
		expect(sent.request.method).toBe('POST')
		expect(sent.url.pathname).toBe('/push/devices')
		expect(sent.body).toEqual({
			token: 'ExponentPushToken[abcdefghijklmnop]',
			platform: 'ios',
			locale: 'ar',
		})
	})

	it('saves switches, and the marketing opt-in with its source', async () => {
		const transport = new StubTransport([
			{ json: { ...PREFS, marketing: true } },
		])
		const saved = await (
			await setup(transport)
		).setPreferences({
			marketing: true,
			source: 'app_prompt',
		})
		expect(saved.marketing).toBe(true)
		expect(transport.recorded[0]!.request.method).toBe('PUT')
		expect(transport.recorded[0]!.body).toEqual({
			marketing: true,
			source: 'app_prompt',
		})
	})

	it('deletes a device, and treats an already deleted one as done', async () => {
		const transport = new StubTransport([
			{ status: 204, raw: '' },
			{ status: 404, json: { error: 'not_found' } },
		])
		const client = await setup(transport)
		await client.remove('dev_1')
		await client.remove('dev_1')
		expect(transport.recorded[0]!.request.method).toBe('DELETE')
		expect(transport.recorded[0]!.url.pathname).toBe('/push/devices/dev_1')
	})

	it('reports an opened push by message id only, and never throws', async () => {
		const transport = new StubTransport([{ status: 500, json: {} }])
		await (await setup(transport)).opened('msg_1')
		expect(transport.recorded[0]!.body).toEqual({ messageId: 'msg_1' })
	})
})
