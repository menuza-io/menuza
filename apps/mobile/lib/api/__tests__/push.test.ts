import {
	fetchAlertSettings,
	listPushDevices,
	registerPushDevice,
	removePushDevice,
	saveAlertSetting,
	type PushApi,
} from '../push'

jest.mock('../index', () => ({
	jwtAuthApi: { authenticatedGet: jest.fn(), authenticatedSend: jest.fn() },
}))

function api(response: unknown): PushApi {
	return {
		authenticatedGet: jest.fn(async () => response),
		authenticatedSend: jest.fn(async () => response),
	} as never
}

describe('push API', () => {
	it('registers a device and unwraps the id', async () => {
		const client = api({ success: true, status: 200, data: { deviceId: 'd1' } })
		const result = await registerPushDevice(
			{ token: 't', platform: 'android', locale: 'ar' },
			client,
		)
		expect(result).toEqual({ ok: true, data: { deviceId: 'd1' } })
		expect(client.authenticatedSend).toHaveBeenCalledWith(
			'POST',
			'/api/push/devices',
			{
				token: 't',
				platform: 'android',
				locale: 'ar',
			},
		)
	})

	it('reads the settings of one organization and saves one change', async () => {
		const client = api({
			success: true,
			status: 200,
			data: { settings: { pushEnabled: true } },
		})
		await fetchAlertSettings('org 1', client)
		expect(client.authenticatedGet).toHaveBeenCalledWith(
			'/api/push/preferences?organizationId=org+1',
		)
		await saveAlertSetting('org_1', { intent: 'snooze', option: '1h' }, client)
		expect(client.authenticatedSend).toHaveBeenCalledWith(
			'PUT',
			'/api/push/preferences',
			{
				organizationId: 'org_1',
				change: { intent: 'snooze', option: '1h' },
			},
		)
	})

	it('lists and removes devices', async () => {
		const client = api({
			success: true,
			status: 200,
			data: { devices: [], removed: 1 },
		})
		expect(await listPushDevices(client)).toMatchObject({ ok: true })
		await removePushDevice({ deviceId: 'd1' }, client)
		expect(client.authenticatedSend).toHaveBeenCalledWith(
			'DELETE',
			'/api/push/devices',
			{
				deviceId: 'd1',
			},
		)
	})

	it('reports the server code and status on a failure', async () => {
		const result = await fetchAlertSettings(
			'o',
			api({
				success: false,
				status: 404,
				error: 'not_found',
				message: 'Not found',
			}),
		)
		expect(result).toEqual({
			ok: false,
			code: 'not_found',
			status: 404,
			message: 'Not found',
		})
	})
})
