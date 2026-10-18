// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
	ReservationsApiError,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'
import { type WaitlistSettings } from '#app/utils/reservations/waitlist-api.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { WaitlistSettingsScreen } from './waitlist-settings.tsx'

const SETTINGS: WaitlistSettings = {
	locationId: 'loc_1',
	version: 3,
	waitlistEnabled: true,
	waitlistOnline: false,
	notifyMeEnabled: true,
	waitlistResponseMin: 10,
	waitlistMaxParties: null,
}

function makeClient(
	options: { putError?: ReservationsApiError; latest?: WaitlistSettings } = {},
) {
	let current = { ...SETTINGS }
	const puts: Array<Record<string, any>> = []
	const request = vi.fn(async (path: string, opts: any = {}) => {
		expect(path).toBe('/operator/reservations/setup/locations/loc_1/waitlist')
		if (opts.method === 'PUT') {
			puts.push(opts.body)
			if (options.putError) {
				current = options.latest ?? { ...current, version: current.version + 1 }
				throw options.putError
			}
			const { expectedVersion, ...patch } = opts.body
			current = { ...current, ...patch, version: expectedVersion + 1 }
		}
		return current
	})
	return {
		puts,
		request,
		client: { scope: 'setup', request } as unknown as ReservationsScopedClient,
	}
}

describe('WaitlistSettingsScreen', () => {
	it('loads the settings and keeps Save off until something changes', async () => {
		const { client } = makeClient()
		renderStaff(
			<WaitlistSettingsScreen client={client} locationId="loc_1" canWrite />,
		)
		expect(await screen.findByTestId('waitlist-settings-form')).toBeTruthy()
		expect(screen.getByTestId('waitlist-setting-enabled')).toBeChecked()
		expect(screen.getByTestId('waitlist-setting-online')).not.toBeChecked()
		expect(screen.getByTestId('waitlist-setting-response-min')).toHaveValue(10)
		expect(screen.queryByTestId('waitlist-settings-save')).toBeNull()
		fireEvent.click(screen.getByTestId('waitlist-setting-online'))
		expect(screen.getByTestId('waitlist-settings-save')).toBeEnabled()
	})

	it('saves the changed values with the version it loaded', async () => {
		const { client, puts } = makeClient()
		const onSaved = vi.fn()
		renderStaff(
			<WaitlistSettingsScreen
				client={client}
				locationId="loc_1"
				canWrite
				onSaved={onSaved}
			/>,
		)
		await screen.findByTestId('waitlist-settings-form')
		fireEvent.click(screen.getByTestId('waitlist-setting-online'))
		fireEvent.change(screen.getByTestId('waitlist-setting-response-min'), {
			target: { value: '15' },
		})
		fireEvent.change(screen.getByTestId('waitlist-setting-max-parties'), {
			target: { value: '40' },
		})
		fireEvent.click(screen.getByTestId('waitlist-settings-save'))

		expect(await screen.findByTestId('waitlist-settings-saved')).toBeTruthy()
		expect(puts).toEqual([
			{
				expectedVersion: 3,
				waitlistEnabled: true,
				waitlistOnline: true,
				notifyMeEnabled: true,
				waitlistResponseMin: 15,
				waitlistMaxParties: 40,
			},
		])
		expect(onSaved).toHaveBeenCalled()
		expect(screen.queryByTestId('waitlist-settings-save')).toBeNull()
	})

	it('rejects an answer window outside 1 to 120 without calling the server', async () => {
		const { client, puts } = makeClient()
		renderStaff(
			<WaitlistSettingsScreen client={client} locationId="loc_1" canWrite />,
		)
		await screen.findByTestId('waitlist-settings-form')
		fireEvent.change(screen.getByTestId('waitlist-setting-response-min'), {
			target: { value: '500' },
		})
		// Submit the form directly: the browser's own range check would otherwise stop the click first.
		fireEvent.submit(screen.getByTestId('waitlist-settings-form'))
		expect(
			await screen.findByTestId('waitlist-settings-form-error'),
		).toHaveTextContent('from 1 to 120')
		expect(puts).toHaveLength(0)
	})

	it('keeps the draft and offers a reload when someone else saved first', async () => {
		const { client, puts } = makeClient({
			putError: new ReservationsApiError('conflict', 409, {
				error: 'stale_version',
			}),
			latest: { ...SETTINGS, version: 4, waitlistResponseMin: 20 },
		})
		renderStaff(
			<WaitlistSettingsScreen client={client} locationId="loc_1" canWrite />,
		)
		await screen.findByTestId('waitlist-settings-form')
		fireEvent.click(screen.getByTestId('waitlist-setting-online'))
		fireEvent.click(screen.getByTestId('waitlist-settings-save'))

		expect(await screen.findByTestId('waitlist-settings-conflict')).toBeTruthy()
		expect(puts).toHaveLength(1)
		expect(screen.getByTestId('waitlist-setting-online')).toBeChecked()
		expect(screen.getByTestId('waitlist-setting-response-min')).toHaveValue(10)

		fireEvent.click(screen.getByTestId('waitlist-settings-reload'))
		await waitFor(() =>
			expect(screen.getByTestId('waitlist-setting-response-min')).toHaveValue(
				20,
			),
		)
		expect(screen.queryByTestId('waitlist-settings-conflict')).toBeNull()
		expect(screen.getByTestId('waitlist-setting-online')).not.toBeChecked()
	})

	it('is read only without write access', async () => {
		const { client } = makeClient()
		renderStaff(
			<WaitlistSettingsScreen
				client={client}
				locationId="loc_1"
				canWrite={false}
			/>,
		)
		await screen.findByTestId('waitlist-settings-form')
		expect(screen.getByTestId('waitlist-settings-read-only')).toBeTruthy()
		expect(screen.getByTestId('waitlist-setting-enabled')).toHaveAttribute(
			'aria-disabled',
			'true',
		)
		expect(screen.queryByTestId('waitlist-settings-save')).toBeNull()
	})

	it('shows a retry when loading fails', async () => {
		const request = vi
			.fn()
			.mockRejectedValueOnce(new ReservationsApiError('boom', 500, {}))
			.mockResolvedValue(SETTINGS)
		renderStaff(
			<WaitlistSettingsScreen
				client={
					{ scope: 'setup', request } as unknown as ReservationsScopedClient
				}
				locationId="loc_1"
				canWrite
			/>,
		)
		expect(await screen.findByTestId('waitlist-settings-error')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
		expect(await screen.findByTestId('waitlist-settings-form')).toBeTruthy()
	})
})
