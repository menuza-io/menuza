// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type BroadcastProblem } from '@repo/common/broadcast-checks'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import { CampaignForm, type CampaignFormProps } from './campaign-form.tsx'

i18n.loadAndActivate({ locale: 'en', messages: {} })

function show(props: CampaignFormProps = {}) {
	const submitted: Array<Record<string, string>> = []
	render(
		<I18nProvider i18n={i18n}>
			<MemoryRouter>
				<form
					onSubmit={(event) => {
						event.preventDefault()
						const submitter = (event.nativeEvent as SubmitEvent).submitter
						const data = new FormData(event.currentTarget, submitter)
						submitted.push(Object.fromEntries(data.entries()) as never)
					}}
				>
					<CampaignForm cancelTo=".." {...props} />
				</form>
			</MemoryRouter>
		</I18nProvider>,
	)
	return submitted
}

describe('CampaignForm without scheduling (Admin and the old composer)', () => {
	it('keeps one plain submit button and no audience or schedule fields', () => {
		show()
		expect(screen.getByRole('button', { name: /send now/i })).toBeTruthy()
		expect(screen.queryByRole('button', { name: /save draft/i })).toBeNull()
		expect(screen.queryByLabelText('Audience')).toBeNull()
		expect(document.querySelector('input[name="scheduledAt"]')).toBeNull()
	})
})

describe('CampaignForm with scheduling', () => {
	it('sends now by default and offers Save draft and Send a test', async () => {
		const user = userEvent.setup()
		const submitted = show({ scheduling: true, canTestSend: true })
		await user.type(screen.getByLabelText('Campaign name'), 'Spring')
		await user.type(screen.getByLabelText('Subject'), 'Hello')
		await user.type(screen.getByLabelText('Message'), 'Come eat')
		expect(screen.getByRole('button', { name: /send a test/i })).toBeTruthy()
		await user.click(screen.getByRole('button', { name: 'Send now' }))
		await waitFor(() => expect(submitted).toHaveLength(1))
		expect(submitted[0]).toMatchObject({
			intent: 'send',
			scheduledAt: '',
			lateAfterHours: '4',
			audience: 'all',
			channel: 'email',
		})
	})

	it('switching to later asks for a time and the late window, and schedules', async () => {
		const user = userEvent.setup()
		const submitted = show({ scheduling: true })
		await user.type(screen.getByLabelText('Campaign name'), 'Spring')
		await user.type(screen.getByLabelText('Subject'), 'Hello')
		await user.type(screen.getByLabelText('Message'), 'Come eat')
		expect(screen.queryByLabelText('Send at')).toBeNull()
		await user.click(screen.getByRole('radio', { name: 'Schedule for later' }))
		expect(screen.getByLabelText('Send at')).toBeTruthy()
		const late = screen.getByLabelText(
			/Don't send if more than this late/,
		) as HTMLSelectElement
		expect(late.value).toBe('4')
		await user.selectOptions(late, '8')
		const input = screen.getByLabelText('Send at') as HTMLInputElement
		await user.type(input, '2099-01-02T10:30')
		await user.click(screen.getByRole('button', { name: 'Schedule' }))
		await waitFor(() => expect(submitted).toHaveLength(1))
		expect(submitted[0]!.intent).toBe('schedule')
		expect(submitted[0]!.lateAfterHours).toBe('8')
		expect(new Date(submitted[0]!.scheduledAt!).getFullYear()).toBe(2099)
	})

	it('Save draft and Send a test skip form validation, and Save draft submits its intent', async () => {
		const user = userEvent.setup()
		const submitted = show({ scheduling: true, canTestSend: true })
		// Browsers skip required-field checks for a `formnovalidate` submitter
		// (jsdom does not), so a half-written draft can be saved.
		expect(
			screen
				.getByRole('button', { name: 'Save draft' })
				.hasAttribute('formnovalidate'),
		).toBe(true)
		expect(
			screen
				.getByRole('button', { name: /send a test/i })
				.hasAttribute('formnovalidate'),
		).toBe(true)
		expect(
			screen
				.getByRole('button', { name: 'Send now' })
				.hasAttribute('formnovalidate'),
		).toBe(false)
		await user.type(screen.getByLabelText('Campaign name'), 'Spring')
		await user.type(screen.getByLabelText('Subject'), 'Hello')
		await user.type(screen.getByLabelText('Message'), 'Come eat')
		await user.click(screen.getByRole('button', { name: 'Save draft' }))
		await waitFor(() => expect(submitted).toHaveLength(1))
		expect(submitted[0]!.intent).toBe('draft')
	})

	it('offers a test only for email, and hides the unverified audience for texts', async () => {
		const user = userEvent.setup()
		show({ scheduling: true, canTestSend: true })
		const audience = screen.getByLabelText('Audience') as HTMLSelectElement
		expect([...audience.options].map((option) => option.value)).toEqual([
			'all',
			'verified',
			'unverified',
		])
		await user.click(screen.getByRole('button', { name: /SMS/ }))
		expect(screen.queryByRole('button', { name: /send a test/i })).toBeNull()
		expect(
			[...(screen.getByLabelText('Audience') as HTMLSelectElement).options].map(
				(option) => option.value,
			),
		).toEqual(['all', 'verified'])
	})

	it('counts the text segments with the opt-out line included (#75)', async () => {
		const user = userEvent.setup()
		show({ scheduling: true })
		await user.click(screen.getByRole('button', { name: /SMS/ }))
		expect(screen.getByText(/Every text ends with/)).toHaveTextContent(
			'Reply STOP to opt out.',
		)
		// 150 characters are one segment on their own; the opt-out line makes two.
		await user.click(screen.getByLabelText('Message'))
		await user.paste('a'.repeat(150))
		expect(screen.getByTestId('sms-count')).toHaveTextContent('150 / 1600')
		expect(screen.getByTestId('sms-count')).toHaveTextContent('Segments: 2')
	})

	it('puts an existing broadcast back: its time, its window, its channel locked', () => {
		const scheduledAt = new Date(Date.now() + 5 * 3_600_000).toISOString()
		show({
			scheduling: true,
			lockChannel: true,
			defaults: {
				name: 'Lunch',
				channel: 'email',
				subject: 'Today',
				content: 'Come eat',
				audience: 'verified',
				scheduledAt,
				lateAfterMinutes: 120,
			},
		})
		expect(
			(screen.getByLabelText('Campaign name') as HTMLInputElement).value,
		).toBe('Lunch')
		expect((screen.getByLabelText('Audience') as HTMLSelectElement).value).toBe(
			'verified',
		)
		expect(
			(
				screen.getByLabelText(
					/Don't send if more than this late/,
				) as HTMLSelectElement
			).value,
		).toBe('2')
		expect(
			screen
				.getByRole('radio', { name: 'Schedule for later' })
				.getAttribute('aria-checked'),
		).toBe('true')
		expect(
			(screen.getByRole('button', { name: /SMS/ }) as HTMLButtonElement)
				.disabled,
		).toBe(true)
		expect(screen.getByRole('button', { name: 'Schedule' })).toBeTruthy()
	})

	it('shows the pre-send check, and Send anyway submits again with the warnings acknowledged', async () => {
		const user = userEvent.setup()
		const problems: BroadcastProblem[] = [
			{ code: 'starter_text', severity: 'warning', blockId: 'b1' },
		]
		const onEditBlock = vi.fn()
		const submitted = show({
			scheduling: true,
			problems,
			onEditBlock,
			defaults: {
				name: 'Spring',
				channel: 'email',
				subject: 'Hi',
				content: 'Hello',
			},
		})
		expect(await screen.findByText('Check before it goes out')).toBeTruthy()
		await user.click(screen.getByRole('button', { name: 'Send anyway' }))
		await waitFor(() => expect(submitted).toHaveLength(1))
		expect(submitted[0]).toMatchObject({
			intent: 'send',
			acknowledgeWarnings: '1',
		})
	})

	it('never offers Send anyway for a blocking problem', async () => {
		show({
			scheduling: true,
			problems: [{ code: 'audience_zero', severity: 'blocking' }],
		})
		expect(await screen.findByText('Fix this before it goes out')).toBeTruthy()
		expect(screen.queryByRole('button', { name: /anyway/i })).toBeNull()
	})

	it('shows the answer of a test send and an error', () => {
		show({
			scheduling: true,
			testResult: { ok: true, message: 'A test was sent to me@x.test.' },
			error: 'Nope',
		})
		expect(screen.getByText('A test was sent to me@x.test.')).toBeTruthy()
		expect(screen.getByText('Nope')).toBeTruthy()
	})

	describe('CampaignForm text allowance (#247)', () => {
		const RESET = Date.UTC(2026, 11, 1)
		const allowance = (remaining: number) => ({
			limit: 4,
			remaining,
			resetsAt: RESET,
		})

		async function textStep(remaining: number) {
			const user = userEvent.setup()
			show({ scheduling: true, smsAllowance: allowance(remaining) })
			await user.click(screen.getByRole('button', { name: /SMS/ }))
			return user
		}

		it('says how many text sends this month has left', async () => {
			await textStep(3)
			expect(screen.getByTestId('sms-allowance')).toHaveTextContent(
				'This uses 1 of your 4 text sends this month. 3 left.',
			)
			expect(screen.getByRole('button', { name: 'Send now' })).toBeEnabled()
		})

		it('says when it is the last one, and when the sends come back', async () => {
			await textStep(1)
			expect(screen.getByTestId('sms-allowance')).toHaveTextContent(
				'This is your last one this month. You get 4 more on December 1, 2026.',
			)
		})

		it('with none left it cannot be sent now, and tells the operator when to schedule it', async () => {
			const user = await textStep(0)
			const alert = screen.getByRole('alert')
			expect(alert).toHaveTextContent(
				'You have used all 4 text sends this month.',
			)
			expect(alert).toHaveTextContent('December 1, 2026')
			// "Send now" is the primary action and it is off.
			const primary = screen
				.getAllByRole('button')
				.find((button) => button.getAttribute('value') === 'send')!
			expect(primary).toBeDisabled()

			// A time this month stays refused; one in the next month is allowed.
			await user.click(
				screen.getByRole('radio', { name: 'Schedule for later' }),
			)
			const when = screen.getByLabelText('Send at')
			fireEvent.change(when, { target: { value: '2099-01-15T10:00' } })
			const scheduleButton = () =>
				screen
					.getAllByRole('button')
					.find((button) => button.getAttribute('value') === 'schedule')!
			expect(scheduleButton()).toBeEnabled()
			fireEvent.change(when, { target: { value: '2026-11-25T10:00' } })
			expect(scheduleButton()).toBeDisabled()
		})

		it('email shows no allowance at all', async () => {
			show({ scheduling: true, smsAllowance: allowance(0) })
			expect(screen.queryByTestId('sms-allowance')).toBeNull()
		})
	})
})
