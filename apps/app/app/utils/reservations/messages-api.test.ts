import { describe, expect, it, vi } from 'vitest'
import {
	fetchMessagePreview,
	fetchMessageSettings,
	saveMessageSettings,
	settingsFromConflict,
} from '#app/utils/reservations/messages-api.ts'
import { makeSettingsResponse } from '#app/utils/reservations/messages-fixtures.ts'
import {
	ReservationsApiError,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'

function fakeClient(response: unknown) {
	const request = vi.fn(async () => response)
	return {
		client: { scope: 'setup', request } as unknown as ReservationsScopedClient,
		request,
	}
}

describe('messages-api', () => {
	it('fetches the settings for a location', async () => {
		const { client, request } = fakeClient(makeSettingsResponse())
		const settings = await fetchMessageSettings(client, 'loc_1')
		expect(request).toHaveBeenCalledWith(
			'/operator/reservations/setup/message-texts',
			{ query: { locationId: 'loc_1' }, signal: undefined },
		)
		expect(settings.version).toBe(3)
		expect(settings.kinds.map((k) => k.kind)).toEqual([
			'confirmation',
			'reminder',
			'reconfirm_request',
			'waitlist_joined',
		])
		expect(settings.noteMaxLength).toBe(500)
	})

	it('rejects a response that is not the settings shape', async () => {
		const { client } = fakeClient({ ok: true })
		await expect(fetchMessageSettings(client, 'loc_1')).rejects.toThrow()
	})

	it('sends the patch with the location and expected version', async () => {
		const { client, request } = fakeClient(makeSettingsResponse({ version: 4 }))
		const saved = await saveMessageSettings(client, 'loc_1', {
			expectedVersion: 3,
			messaging: { kinds: { reminder: false } },
			texts: [{ kind: 'confirmation', locale: 'ar', customNote: 'أهلا' }],
		})
		expect(request).toHaveBeenCalledWith(
			'/operator/reservations/setup/message-texts',
			{
				method: 'PUT',
				body: {
					locationId: 'loc_1',
					expectedVersion: 3,
					messaging: { kinds: { reminder: false } },
					texts: [{ kind: 'confirmation', locale: 'ar', customNote: 'أهلا' }],
				},
			},
		)
		expect(saved.version).toBe(4)
	})

	it('fetches a preview by kind and locale', async () => {
		const { client, request } = fakeClient({
			ok: true,
			kind: 'reminder',
			locale: 'ar',
			sample: true,
			subject: 'Subject',
			html: '<p>Hi</p>',
			text: 'Hi',
			sms: 'Hi there',
		})
		const preview = await fetchMessagePreview(client, 'loc_1', {
			kind: 'reminder',
			locale: 'ar',
		})
		expect(request).toHaveBeenCalledWith(
			'/operator/reservations/setup/message-texts/preview',
			{
				query: { locationId: 'loc_1', kind: 'reminder', locale: 'ar' },
				signal: undefined,
			},
		)
		expect(preview.html).toBe('<p>Hi</p>')
		expect(preview.sms).toBe('Hi there')
	})

	it('reads the current settings out of a stale_version conflict', () => {
		const current = makeSettingsResponse({ version: 9 })
		const err = new ReservationsApiError('stale_version', 409, {
			error: 'stale_version',
			current,
			settings: current,
			version: 9,
		})
		expect(settingsFromConflict(err)?.version).toBe(9)
		expect(settingsFromConflict(new Error('x'))).toBeNull()
		expect(
			settingsFromConflict(
				new ReservationsApiError('stale_version', 409, {
					error: 'stale_version',
				}),
			),
		).toBeNull()
	})
})
