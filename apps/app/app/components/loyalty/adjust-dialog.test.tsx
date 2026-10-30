// @vitest-environment jsdom
import { type LoyaltyMemberSummary } from '@repo/loyalty'
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
	LoyaltyApiError,
	type LoyaltyClient,
} from '#app/utils/loyalty/loyalty-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { AdjustDialog } from './adjust-dialog.tsx'

const MEMBER: LoyaltyMemberSummary = {
	id: 'mem_1',
	customerId: 'cus_1',
	name: 'Ada Lovelace',
	phoneLast4: '0001',
	status: 'active',
	createdAt: 1000,
	balance: {
		points: 40,
		reserved: 0,
		available: 40,
		lifetimeEarned: 40,
		lifetimeRedeemed: 0,
	},
	lastPurchaseAt: null,
}

function setup(
	adjustMember: LoyaltyClient['adjustMember'],
	member: LoyaltyMemberSummary = MEMBER,
) {
	const client = { adjustMember: vi.fn(adjustMember) }
	const onAdjusted = vi.fn()
	const onOpenChange = vi.fn()
	const view = renderStaff(
		<AdjustDialog
			client={client as unknown as LoyaltyClient}
			member={member}
			open
			onOpenChange={onOpenChange}
			onAdjusted={onAdjusted}
		/>,
	)
	return { client, onAdjusted, onOpenChange, view }
}

const RESULT = {
	entry: { id: 'led_1' },
	balance: {
		points: 45,
		reserved: 0,
		available: 45,
		version: 2,
		updatedAt: 2000,
	},
} as never

async function submitAdjustment() {
	await userEvent.type(screen.getByTestId('loyalty-adjust-delta'), '5')
	await userEvent.type(
		screen.getByTestId('loyalty-adjust-note'),
		'Goodwill for the wait',
	)
	await userEvent.click(screen.getByTestId('loyalty-adjust-submit'))
}

function keyOf(
	call: number,
	client: { adjustMember: ReturnType<typeof vi.fn> },
) {
	return client.adjustMember.mock.calls[call]?.[2] as string
}

describe('AdjustDialog', () => {
	it('rotates the idempotency key after a success, keeps it for a retry', async () => {
		const { client, onAdjusted } = setup(async () => RESULT)
		await submitAdjustment()
		await waitFor(() => expect(onAdjusted).toHaveBeenCalled())
		const first = keyOf(0, client)
		expect(first).toMatch(/^lty-adjust-/)

		// The same adjustment submitted again is deliberate: a fresh key.
		await userEvent.click(screen.getByTestId('loyalty-adjust-submit'))
		await waitFor(() => expect(client.adjustMember).toHaveBeenCalledTimes(2))
		expect(keyOf(1, client)).not.toBe(first)
	})

	it('replays the same key when a failed submit is retried', async () => {
		const { client } = setup(
			vi
				.fn()
				.mockRejectedValueOnce(new LoyaltyApiError('down', 500))
				.mockResolvedValue(RESULT) as never,
		)
		await submitAdjustment()
		expect(
			await screen.findByTestId('loyalty-adjust-error'),
		).toBeInTheDocument()
		const first = keyOf(0, client)

		await userEvent.click(screen.getByTestId('loyalty-adjust-submit'))
		await waitFor(() => expect(client.adjustMember).toHaveBeenCalledTimes(2))
		expect(keyOf(1, client)).toBe(first)
	})

	it('derives the key from the member, its balance and the content', async () => {
		const lost = () => Promise.reject(new TypeError('Failed to fetch'))
		const first = setup(lost as never)
		await submitAdjustment()
		expect(
			await screen.findByTestId('loyalty-adjust-error'),
		).toBeInTheDocument()
		const key = keyOf(0, first.client)
		expect(key).toMatch(/^lty-adjust-/)
		first.view.unmount()

		// Closed and reopened after a lost response: the same adjustment
		// replays the first attempt instead of adding the points twice.
		const second = setup(async () => RESULT)
		await submitAdjustment()
		await waitFor(() => expect(second.onAdjusted).toHaveBeenCalled())
		expect(keyOf(0, second.client)).toBe(key)
		second.view.unmount()

		// The adjustment landed and the balance moved: a new key.
		const third = setup(async () => RESULT, {
			...MEMBER,
			balance: {
				points: 45,
				reserved: 0,
				available: 45,
				lifetimeEarned: 45,
				lifetimeRedeemed: 0,
			},
		})
		await submitAdjustment()
		await waitFor(() => expect(third.onAdjusted).toHaveBeenCalled())
		expect(keyOf(0, third.client)).not.toBe(key)
		third.view.unmount()

		// Another member with the same balance and content: a different key.
		const other = setup(async () => RESULT, { ...MEMBER, id: 'mem_2' })
		await submitAdjustment()
		await waitFor(() => expect(other.onAdjusted).toHaveBeenCalled())
		expect(keyOf(0, other.client)).not.toBe(key)
	})

	it('starts clean when it is reopened after a cancel', async () => {
		const client = {
			adjustMember: vi.fn(async () => {
				throw new LoyaltyApiError('down', 500)
			}),
		}
		function Harness() {
			const [open, setOpen] = useState(true)
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Reopen
					</button>
					<AdjustDialog
						client={client as unknown as LoyaltyClient}
						member={MEMBER}
						open={open}
						onOpenChange={setOpen}
						onAdjusted={vi.fn()}
					/>
				</>
			)
		}
		renderStaff(<Harness />)
		await submitAdjustment()
		expect(
			await screen.findByTestId('loyalty-adjust-error'),
		).toBeInTheDocument()

		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		await waitFor(() =>
			expect(screen.queryByTestId('loyalty-adjust-dialog')).toBeNull(),
		)
		await userEvent.click(screen.getByRole('button', { name: 'Reopen' }))

		expect(await screen.findByTestId('loyalty-adjust-dialog')).toBeVisible()
		expect(screen.queryByTestId('loyalty-adjust-error')).toBeNull()
		expect(screen.getByTestId('loyalty-adjust-delta')).toHaveValue('')
		expect(screen.getByTestId('loyalty-adjust-note')).toHaveValue('')
	})

	it('explains the 24-hour limit rather than a generic busy message', async () => {
		setup(async () => {
			throw new LoyaltyApiError('limit', 429, 'adjustment_limit')
		})
		await submitAdjustment()
		expect(await screen.findByTestId('loyalty-adjust-error')).toHaveTextContent(
			'This goes over the most points one person can add in 24 hours.',
		)
	})

	it('cannot be closed while a submit is in flight', async () => {
		let release!: (value: never) => void
		const { onOpenChange } = setup(
			(() => new Promise((resolve) => (release = resolve))) as never,
		)
		await submitAdjustment()
		expect(screen.getByTestId('loyalty-adjust-submit')).toBeDisabled()

		await userEvent.keyboard('{Escape}')
		expect(onOpenChange).not.toHaveBeenCalled()

		release(RESULT)
		await waitFor(() =>
			expect(screen.getByTestId('loyalty-adjust-submit')).toBeEnabled(),
		)
		await userEvent.keyboard('{Escape}')
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it('reads Arabic-Indic digits and the minus sign the pages print', async () => {
		const { client } = setup(async () => RESULT)
		await userEvent.type(
			screen.getByTestId('loyalty-adjust-delta'),
			'\u2212\u0661\u0662',
		)
		await userEvent.type(
			screen.getByTestId('loyalty-adjust-note'),
			'Charged twice',
		)
		await userEvent.click(screen.getByTestId('loyalty-adjust-submit'))
		await waitFor(() => expect(client.adjustMember).toHaveBeenCalled())
		expect(client.adjustMember.mock.calls[0]?.[1]).toEqual({
			delta: -12,
			reason: 'goodwill',
			note: 'Charged twice',
		})
	})

	it('reads a leading plus sign as points to add', async () => {
		const { client } = setup(async () => RESULT)
		await userEvent.type(screen.getByTestId('loyalty-adjust-delta'), '+50')
		await userEvent.type(
			screen.getByTestId('loyalty-adjust-note'),
			'Birthday treat',
		)
		await userEvent.click(screen.getByTestId('loyalty-adjust-submit'))
		await waitFor(() => expect(client.adjustMember).toHaveBeenCalled())
		expect(client.adjustMember.mock.calls[0]?.[1]).toEqual({
			delta: 50,
			reason: 'goodwill',
			note: 'Birthday treat',
		})
	})

	it('asks phones for a keyboard that has a minus key', () => {
		setup(async () => RESULT)
		// The iPhone number pad that inputmode="numeric" opens has no minus.
		expect(screen.getByTestId('loyalty-adjust-delta')).toHaveAttribute(
			'inputmode',
			'text',
		)
	})

	it('states the largest adjustment as a formatted number', async () => {
		const { client } = setup(async () => RESULT)
		await userEvent.type(screen.getByTestId('loyalty-adjust-delta'), '1000001')
		await userEvent.type(
			screen.getByTestId('loyalty-adjust-note'),
			'Too many at once',
		)
		await userEvent.click(screen.getByTestId('loyalty-adjust-submit'))
		expect(
			await screen.findByText('Adjust at most 1,000,000 points at a time.'),
		).toBeInTheDocument()
		expect(client.adjustMember).not.toHaveBeenCalled()
	})
})
