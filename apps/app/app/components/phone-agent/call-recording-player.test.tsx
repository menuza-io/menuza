// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhoneCallsError } from '#app/hooks/use-phone-calls.ts'
import { CallRecordingPlayer } from './call-recording-player.tsx'

const link = (n: number) => ({
	url: `https://bucket.example.com/voice-recordings/org/call_1.ogg?sig=${n}`,
	expiresAt: '2026-10-14T12:05:00.000Z',
})

function renderPlayer(request: (path: string) => Promise<unknown>) {
	return render(
		<I18nProvider i18n={i18n}>
			<CallRecordingPlayer callId="call_1" request={request} />
		</I18nProvider>,
	)
}

describe('CallRecordingPlayer', () => {
	beforeEach(() => {
		i18n.loadAndActivate({ locale: 'en', messages: {} })
	})

	afterEach(() => cleanup())

	it('plays the signed link for this call', async () => {
		const request = vi.fn().mockResolvedValue(link(1))
		renderPlayer(request)
		const audio = await screen.findByLabelText('Call recording')
		expect(audio).toHaveAttribute('src', link(1).url)
		expect(request).toHaveBeenCalledWith('/call_1/recording', {
			signal: expect.any(AbortSignal),
		})
	})

	it('renews an expired link once, then reports the failure', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(link(1))
			.mockResolvedValueOnce(link(2))
		renderPlayer(request)
		fireEvent.error(await screen.findByLabelText('Call recording'))
		await waitFor(() =>
			expect(screen.getByLabelText('Call recording')).toHaveAttribute(
				'src',
				link(2).url,
			),
		)
		fireEvent.error(screen.getByLabelText('Call recording'))
		expect(
			await screen.findByText("This recording couldn't be played."),
		).toBeInTheDocument()
		expect(request).toHaveBeenCalledTimes(2)
	})

	it('explains a recording that is gone, without a retry', async () => {
		renderPlayer(
			vi.fn().mockRejectedValue(new PhoneCallsError('Not found', 404)),
		)
		expect(
			await screen.findByText('This recording is no longer available.'),
		).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
	})

	it('explains when playback is not set up', async () => {
		renderPlayer(
			vi.fn().mockRejectedValue(new PhoneCallsError('Unavailable', 503)),
		)
		expect(
			await screen.findByText(
				"Recording playback isn't set up for your account yet.",
			),
		).toBeInTheDocument()
	})

	it('retries other failures on request', async () => {
		const request = vi
			.fn()
			.mockRejectedValueOnce(new PhoneCallsError('Down', 500))
			.mockResolvedValueOnce(link(1))
		renderPlayer(request)
		await userEvent.click(
			await screen.findByRole('button', { name: 'Try again' }),
		)
		expect(await screen.findByLabelText('Call recording')).toHaveAttribute(
			'src',
			link(1).url,
		)
	})
})
