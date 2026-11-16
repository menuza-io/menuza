// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type DiscountUsedIn } from '@repo/discounts'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	MessageImpactDialog,
	ResumeWithAutomationsDialog,
	UsedInPanel,
	useMessageImpact,
	type ImpactPermissions,
} from './message-impact.tsx'

const fetchUsedIn = vi.hoisted(() => vi.fn())
vi.mock('#app/utils/discounts/usage-client.ts', () => ({
	createDiscountUsageClient: () => ({ fetchUsedIn }),
}))

const usedIn: DiscountUsedIn = {
	automations: [
		{ id: 'a1', name: 'Welcome' },
		{ id: 'a2', name: 'Win back' },
	],
	broadcasts: [
		{
			id: 'b1',
			name: 'Friday special',
			status: 'Scheduled',
			scheduledAt: 1_900_000_000_000,
		},
		{ id: 'b2', name: 'Right now', status: 'Processing', scheduledAt: null },
	],
	issuedCodes: 4,
}
const everything: ImpactPermissions = {
	canChangeAutomations: true,
	canChangeBroadcasts: true,
	canOpenAutomations: true,
	canOpenBroadcasts: true,
}

function wrap(node: React.ReactNode) {
	i18n.load('en', {})
	i18n.activate('en')
	return render(
		<I18nProvider i18n={i18n}>
			<MemoryRouter>{node}</MemoryRouter>
		</I18nProvider>,
	)
}

function dialog(
	props: Partial<React.ComponentProps<typeof MessageImpactDialog>> = {},
) {
	const onConfirm = vi.fn()
	const onClose = vi.fn()
	wrap(
		<MessageImpactDialog
			open
			orgSlug="acme"
			discountName="Lunch deal"
			kind="pause"
			usedIn={usedIn}
			permissions={everything}
			onConfirm={onConfirm}
			onClose={onClose}
			{...props}
		/>,
	)
	return { onConfirm, onClose }
}

describe('MessageImpactDialog', () => {
	it('names the messages and the codes that keep working, and asks before pausing', () => {
		dialog()
		expect(screen.getByText('Pause Lunch deal?')).toBeTruthy()
		expect(screen.getByText('Welcome')).toBeTruthy()
		expect(screen.getByText('Win back')).toBeTruthy()
		expect(screen.getByText('Friday special')).toBeTruthy()
		expect(screen.getAllByText(/sending now/).length).toBeGreaterThanOrEqual(2)
		expect(
			screen.getByText(
				'4 single-use codes already sent keep working until they expire.',
			),
		).toBeTruthy()
	})

	it('words each kind of change', () => {
		dialog({ kind: 'archive' })
		expect(screen.getByText('Archive Lunch deal?')).toBeTruthy()
	})

	it('words an end date and a code or amount change', () => {
		const first = render(<div />)
		first.unmount()
		dialog({ kind: 'shorten_end' })
		expect(screen.getByText('Shorten the end date of Lunch deal?')).toBeTruthy()
	})

	it('pauses the automations and cancels the scheduled broadcasts when asked, in one action', async () => {
		const user = userEvent.setup()
		const { onConfirm } = dialog()
		expect(
			screen
				.getByRole('checkbox', { name: 'Pause these 2 automations too' })
				.getAttribute('aria-checked'),
		).toBe('true')
		// Only the scheduled broadcast can be cancelled; the one sending cannot.
		expect(
			screen.getByRole('checkbox', { name: 'Cancel this scheduled broadcast' }),
		).toBeTruthy()
		expect(
			screen.getByText(
				'A broadcast is sending now. A send that has started cannot be stopped.',
			),
		).toBeTruthy()
		await user.click(
			screen.getByRole('button', {
				name: 'Continue and update these messages',
			}),
		)
		expect(onConfirm).toHaveBeenCalledWith({
			pauseAutomations: true,
			cancelBroadcasts: true,
		})
	})

	it('continues without touching them when both are unticked', async () => {
		const user = userEvent.setup()
		const { onConfirm } = dialog()
		await user.click(
			screen.getByRole('checkbox', { name: 'Pause these 2 automations too' }),
		)
		await user.click(
			screen.getByRole('checkbox', { name: 'Cancel this scheduled broadcast' }),
		)
		await user.click(
			screen.getByRole('button', { name: 'Continue without changing them' }),
		)
		expect(onConfirm).toHaveBeenCalledWith({
			pauseAutomations: false,
			cancelBroadcasts: false,
		})
	})

	it('a member who can edit discounts but not campaigns sees the list and cannot pause or cancel', async () => {
		const user = userEvent.setup()
		const { onConfirm } = dialog({
			permissions: {
				canChangeAutomations: false,
				canChangeBroadcasts: false,
				canOpenAutomations: false,
				canOpenBroadcasts: false,
			},
		})
		expect(screen.getByText('Welcome')).toBeTruthy()
		const pause = screen.getByRole('checkbox', {
			name: 'Pause these 2 automations too',
		})
		expect(
			pause.hasAttribute('data-disabled') ||
				pause.getAttribute('aria-disabled') === 'true' ||
				(pause as HTMLButtonElement).disabled,
		).toBe(true)
		expect(pause.getAttribute('aria-checked')).toBe('false')
		expect(
			screen.getByText(/Ask someone who can to pause or cancel these/),
		).toBeTruthy()
		// Without read access the names are not links.
		expect(screen.queryByRole('link', { name: 'Welcome' })).toBeNull()
		await user.click(
			screen.getByRole('button', { name: 'Continue without changing them' }),
		)
		expect(onConfirm).toHaveBeenCalledWith({
			pauseAutomations: false,
			cancelBroadcasts: false,
		})
	})

	it('can offer one kind and refuse the other', async () => {
		const user = userEvent.setup()
		const { onConfirm } = dialog({
			permissions: { ...everything, canChangeBroadcasts: false },
		})
		expect(screen.getByText(/Ask someone who can/)).toBeTruthy()
		await user.click(
			screen.getByRole('button', {
				name: 'Continue and update these messages',
			}),
		)
		expect(onConfirm).toHaveBeenCalledWith({
			pauseAutomations: true,
			cancelBroadcasts: false,
		})
	})

	it('links the messages a member may open, and goes back', async () => {
		const user = userEvent.setup()
		const { onClose, onConfirm } = dialog()
		expect(
			screen.getByRole('link', { name: 'Welcome' }).getAttribute('href'),
		).toBe('/acme/marketing/automations/a1')
		expect(
			screen.getByRole('link', { name: 'Friday special' }).getAttribute('href'),
		).toBe('/acme/marketing/campaigns/b1')
		await user.click(screen.getByRole('button', { name: 'Go back' }))
		expect(onClose).toHaveBeenCalled()
		expect(onConfirm).not.toHaveBeenCalled()
	})
})

describe('UsedInPanel', () => {
	beforeEach(() => fetchUsedIn.mockReset())

	it('lists where a discount is promised', async () => {
		fetchUsedIn.mockResolvedValue(usedIn)
		wrap(
			<UsedInPanel orgSlug="acme" discountId="d1" permissions={everything} />,
		)
		expect(screen.getByText('Used in')).toBeTruthy()
		expect(await screen.findByText('Welcome')).toBeTruthy()
		expect(screen.getByText('Friday special')).toBeTruthy()
		expect(fetchUsedIn).toHaveBeenCalledWith('d1', expect.anything())
	})

	it('says so when nothing is waiting, and when the region cannot be reached', async () => {
		fetchUsedIn.mockResolvedValueOnce({
			automations: [],
			broadcasts: [],
			issuedCodes: 0,
		})
		const first = wrap(
			<UsedInPanel orgSlug="acme" discountId="d1" permissions={everything} />,
		)
		expect(
			await screen.findByText(/No broadcast waiting to go out/),
		).toBeTruthy()
		first.unmount()
		fetchUsedIn.mockResolvedValueOnce(null)
		wrap(
			<UsedInPanel orgSlug="acme" discountId="d1" permissions={everything} />,
		)
		expect(
			await screen.findByText(/Could not check which messages/),
		).toBeTruthy()
	})
})

function Harness({ proceed }: { proceed: (choice: unknown) => void }) {
	const impact = useMessageImpact({ orgSlug: 'acme', permissions: everything })
	return (
		<>
			<button
				type="button"
				onClick={() =>
					impact.guard({
						discountId: 'd1',
						discountName: 'Lunch deal',
						kind: 'pause',
						proceed,
					})
				}
			>
				Pause
			</button>
			{impact.render}
		</>
	)
}

describe('useMessageImpact', () => {
	beforeEach(() => fetchUsedIn.mockReset())

	it('lets the change through at once when nothing is promised', async () => {
		const user = userEvent.setup()
		const proceed = vi.fn()
		fetchUsedIn.mockResolvedValue({
			automations: [],
			broadcasts: [],
			issuedCodes: 2,
		})
		wrap(<Harness proceed={proceed} />)
		await user.click(screen.getByRole('button', { name: 'Pause' }))
		await waitFor(() => expect(proceed).toHaveBeenCalledWith(null))
		expect(screen.queryByRole('dialog')).toBeNull()
	})

	it('does not block when the region cannot be reached: it is a warning, not a gate', async () => {
		const user = userEvent.setup()
		const proceed = vi.fn()
		fetchUsedIn.mockResolvedValue(null)
		wrap(<Harness proceed={proceed} />)
		await user.click(screen.getByRole('button', { name: 'Pause' }))
		await waitFor(() => expect(proceed).toHaveBeenCalledWith(null))
	})

	it('asks first when messages promise it, and proceeds with the choice', async () => {
		const user = userEvent.setup()
		const proceed = vi.fn()
		fetchUsedIn.mockResolvedValue(usedIn)
		wrap(<Harness proceed={proceed} />)
		await user.click(screen.getByRole('button', { name: 'Pause' }))
		expect(await screen.findByText('Pause Lunch deal?')).toBeTruthy()
		expect(proceed).not.toHaveBeenCalled()
		await user.click(
			screen.getByRole('button', {
				name: 'Continue and update these messages',
			}),
		)
		expect(proceed).toHaveBeenCalledWith({
			pauseAutomations: true,
			cancelBroadcasts: true,
		})
	})

	it('going back changes nothing', async () => {
		const user = userEvent.setup()
		const proceed = vi.fn()
		fetchUsedIn.mockResolvedValue(usedIn)
		wrap(<Harness proceed={proceed} />)
		await user.click(screen.getByRole('button', { name: 'Pause' }))
		await user.click(await screen.findByRole('button', { name: 'Go back' }))
		await waitFor(() =>
			expect(screen.queryByText('Pause Lunch deal?')).toBeNull(),
		)
		expect(proceed).not.toHaveBeenCalled()
	})
})

describe('ResumeWithAutomationsDialog', () => {
	it('offers the paired automations back, or only the discount', async () => {
		const user = userEvent.setup()
		const onResume = vi.fn()
		const onClose = vi.fn()
		wrap(
			<ResumeWithAutomationsDialog
				open
				discountName="Lunch deal"
				automations={[{ id: 'a1', name: 'Welcome' }]}
				onResume={onResume}
				onClose={onClose}
			/>,
		)
		expect(screen.getByText('Resume Lunch deal?')).toBeTruthy()
		expect(screen.getByText('Welcome')).toBeTruthy()
		await user.click(
			screen.getByRole('button', { name: 'Resume only the discount' }),
		)
		expect(onResume).toHaveBeenLastCalledWith(false)
		await user.click(
			screen.getByRole('button', {
				name: 'Resume the discount and the automations',
			}),
		)
		expect(onResume).toHaveBeenLastCalledWith(true)
	})
})
