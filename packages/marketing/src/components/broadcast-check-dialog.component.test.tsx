// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type BroadcastProblem } from '@repo/common/broadcast-checks'
import { type EmailBlock } from '@repo/common/email-blocks'
import { getDefaultEmailBlock } from '@repo/common/email-blocks'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { BroadcastCheckDialog } from './broadcast-check-dialog.tsx'

i18n.loadAndActivate({ locale: 'en', messages: {} })

const heading = getDefaultEmailBlock('heading')
const image = getDefaultEmailBlock('image')
const blocks: EmailBlock[] = [heading, image]

function show(
	problems: BroadcastProblem[],
	props: Partial<React.ComponentProps<typeof BroadcastCheckDialog>> = {},
) {
	const onEditBlock = vi.fn()
	const onSendAnyway = vi.fn()
	const onOpenChange = vi.fn()
	render(
		<I18nProvider i18n={i18n}>
			<BroadcastCheckDialog
				open
				onOpenChange={onOpenChange}
				problems={problems}
				blocks={blocks}
				onEditBlock={onEditBlock}
				onSendAnyway={onSendAnyway}
				{...props}
			/>
		</I18nProvider>,
	)
	return { onEditBlock, onSendAnyway, onOpenChange }
}

describe('BroadcastCheckDialog', () => {
	it('offers no way past a blocking problem, only Edit', () => {
		show([
			{ code: 'empty_image', severity: 'blocking', blockId: image.id },
			{ code: 'starter_text', severity: 'warning', blockId: heading.id },
		])
		expect(screen.getByText('Fix this before it goes out')).toBeTruthy()
		expect(screen.queryByRole('button', { name: /anyway/i })).toBeNull()
	})

	it('names the block and links to it', async () => {
		const user = userEvent.setup()
		const { onEditBlock, onOpenChange } = show([
			{ code: 'empty_image', severity: 'blocking', blockId: image.id },
		])
		expect(screen.getByText(/Block 2: Image/)).toBeTruthy()
		expect(screen.getByText('This image block has no picture.')).toBeTruthy()
		// The row's own Edit link, then the footer's.
		const edits = screen.getAllByRole('button', { name: 'Edit' })
		await user.click(edits[0]!)
		expect(onEditBlock).toHaveBeenCalledWith(image.id)
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it('lets a warning through with Send anyway, or Schedule anyway when scheduling', async () => {
		const user = userEvent.setup()
		const warning: BroadcastProblem = {
			code: 'starter_text',
			severity: 'warning',
			blockId: heading.id,
		}
		const first = show([warning])
		expect(screen.getByText('Check before it goes out')).toBeTruthy()
		await user.click(screen.getByRole('button', { name: 'Send anyway' }))
		expect(first.onSendAnyway).toHaveBeenCalledTimes(1)
	})

	it('says Schedule anyway for a scheduled send', () => {
		show([{ code: 'boilerplate_phrase', severity: 'warning' }], {
			scheduling: true,
		})
		expect(screen.getByRole('button', { name: 'Schedule anyway' })).toBeTruthy()
		// A problem outside any block has no per-block link.
		expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1)
	})

	it('words every kind of problem', () => {
		const codes = [
			'empty_message',
			'empty_button_link',
			'empty_menu_item',
			'empty_coupon',
			'coupon_missing',
			'coupon_paused',
			'coupon_ended_before_send',
			'audience_zero',
		] as const
		show(codes.map((code) => ({ code, severity: 'blocking' })))
		expect(
			screen.getByText(
				'Nobody would receive this: no one in the audience is subscribed.',
			),
		).toBeTruthy()
		expect(screen.getByText(/ends before this would go out/)).toBeTruthy()
		expect(screen.getByText(/is paused, archived or gone/)).toBeTruthy()
		expect(screen.getByText(/needs a coupon/)).toBeTruthy()
	})
})
