// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallsTab } from './calls-tab.tsx'

const mocks = vi.hoisted(() => ({
	request: vi.fn(),
	panel: vi.fn(),
}))

vi.mock('#app/hooks/use-phone-calls.ts', () => ({
	usePhoneCallsClient: () => mocks.request,
	phoneCallsErrorMessage: (ignoredCause: unknown, fallback: string) => fallback,
}))
vi.mock('#app/components/phone-agent/call-detail-sheet.tsx', () => ({
	CallDetailPanel: (props: {
		callId: string
		onCallChanged: (
			callId: string,
			patch: { followUpStatus: 'open' | 'resolved'; tags: string[] },
		) => void
	}) => {
		mocks.panel(props)
		return (
			<button
				type="button"
				onClick={() =>
					props.onCallChanged(props.callId, {
						followUpStatus: 'resolved',
						tags: [],
					})
				}
			>
				Mark {props.callId} complete
			</button>
		)
	},
}))

function call(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		channel: 'phone',
		scopeId: 'scope_1',
		callerPhone: '+14155550123',
		customerName: null,
		purpose: 'business_information',
		outcome: 'completed',
		summary: `Summary for ${id}`,
		startedAt: '2026-10-07T18:00:00.000Z',
		durationSeconds: 95,
		hasRecording: false,
		followUpStatus: 'open',
		followUpResolvedAt: null,
		tags: [],
		rating: null,
		sentiment: null,
		transferResult: 'none',
		voicemail: false,
		calledWhileOpen: null,
		linkSent: false,
		...overrides,
	}
}

function list(calls: unknown[], openFollowUps = calls.length) {
	return {
		calls,
		nextCursor: null,
		purposeCounts: [],
		openRequests: 0,
		openFollowUps,
	}
}

function renderTab(onOpenCountChange = vi.fn()) {
	render(
		<I18nProvider i18n={i18n}>
			<MemoryRouter>
				<CallsTab
					orgSlug="acme"
					scopeNames={{ scope_1: 'North office' }}
					canUpdate
					canDelete={false}
					tags={[]}
					onOpenCountChange={onOpenCountChange}
				/>
			</MemoryRouter>
		</I18nProvider>,
	)
	return { onOpenCountChange }
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
	mocks.request.mockReset()
	mocks.panel.mockReset()
})

afterEach(() => {
	cleanup()
})

describe('mailbox calls tab', () => {
	it('lists only calls that need follow-up and reports the count', async () => {
		mocks.request.mockResolvedValue(list([call('call_1')], 3))
		const { onOpenCountChange } = renderTab()

		expect(await screen.findByText('Summary for call_1')).toBeTruthy()
		expect(screen.getByText('North office')).toBeTruthy()
		expect(screen.getByText('3 need follow-up')).toBeTruthy()
		expect(mocks.request).toHaveBeenCalledWith(
			'/?followUp=open&limit=50',
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
		await waitFor(() => expect(onOpenCountChange).toHaveBeenLastCalledWith(3))
	})

	it('explains the empty state', async () => {
		mocks.request.mockResolvedValue(list([]))
		renderTab()
		expect(await screen.findByText('No calls need follow-up')).toBeTruthy()
	})

	it('keeps a completed call in view and lowers the count', async () => {
		mocks.request.mockResolvedValue(list([call('call_1'), call('call_2')]))
		const user = userEvent.setup()
		const { onOpenCountChange } = renderTab()

		await user.click(await screen.findByText('Summary for call_1'))
		expect(mocks.panel).toHaveBeenLastCalledWith(
			expect.objectContaining({ callId: 'call_1', canUpdate: true }),
		)
		await user.click(screen.getByText('Mark call_1 complete'))

		await waitFor(() => expect(onOpenCountChange).toHaveBeenLastCalledWith(1))
		expect(screen.getByText('Summary for call_1')).toBeTruthy()
		expect(screen.getByText('Complete')).toBeTruthy()
	})

	it('ignores a refresh that started before a call was completed', async () => {
		let resolveStale: (value: unknown) => void = () => {}
		mocks.request
			.mockResolvedValueOnce(list([call('call_1'), call('call_2')]))
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveStale = resolve
				}),
			)
			.mockResolvedValue(list([call('call_2')], 1))
		const user = userEvent.setup()
		const { onOpenCountChange } = renderTab()

		await user.click(await screen.findByText('Summary for call_1'))
		window.dispatchEvent(new Event('focus'))
		await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2))
		await user.click(screen.getByText('Mark call_1 complete'))
		resolveStale(list([call('call_1'), call('call_2')], 2))

		await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(3))
		await waitFor(() => expect(onOpenCountChange).toHaveBeenLastCalledWith(1))
		expect(screen.getByText('Complete')).toBeTruthy()
		expect(onOpenCountChange).not.toHaveBeenLastCalledWith(2)
	})

	it('shows an error with a retry', async () => {
		mocks.request
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValueOnce(list([call('call_1')]))
		const user = userEvent.setup()
		renderTab()

		expect(
			await screen.findByText('Unable to load calls. Try again.'),
		).toBeTruthy()
		await user.click(screen.getByText('Try again'))
		expect(await screen.findByText('Summary for call_1')).toBeTruthy()
	})
})
