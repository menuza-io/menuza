// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	defaultHomeConfig,
	MAX_DASHBOARD_BLOCKS,
	type DashboardBlock,
} from '#app/utils/dashboards/config.ts'
import {
	AddBlockDialog,
	AddBlockOption,
	AddBlockSection,
} from './add-block-dialog.tsx'

const defaultBlocks = defaultHomeConfig().blocks

function without(type: DashboardBlock['type']) {
	return defaultBlocks.filter((block) => block.type !== type)
}

async function openDialog(
	props: Partial<Parameters<typeof AddBlockDialog>[0]> = {},
) {
	const onAdd = vi.fn()
	render(
		<I18nProvider i18n={i18n}>
			<AddBlockDialog
				blocks={defaultBlocks}
				picker={{ onboardingAvailable: true }}
				onAdd={onAdd}
				{...props}
			/>
		</I18nProvider>,
	)
	await userEvent.click(screen.getByRole('button', { name: 'Add block' }))
	return { onAdd, dialog: await screen.findByRole('dialog') }
}

function builtInOptions(dialog: HTMLElement) {
	const group = within(dialog).getByRole('group', { name: 'Built-in blocks' })
	return within(group)
		.queryAllByRole('button')
		.map((button) => button.firstElementChild?.textContent)
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

describe('AddBlockDialog', () => {
	it('offers only the built-in blocks that are not on the dashboard', async () => {
		const { dialog } = await openDialog({ blocks: without('leaderboard') })
		expect(builtInOptions(dialog)).toEqual(['Top contributors'])
	})

	it('says so when every built-in block is already there', async () => {
		const { dialog } = await openDialog()
		expect(builtInOptions(dialog)).toEqual([])
		expect(
			within(dialog).getByText(
				'All built-in blocks are already on this dashboard.',
			),
		).toBeInTheDocument()
	})

	it('offers onboarding only while the viewer would see it', async () => {
		const hidden = await openDialog({
			blocks: without('onboarding'),
			picker: { onboardingAvailable: false },
		})
		expect(builtInOptions(hidden.dialog)).toEqual([])
		cleanup()

		const shown = await openDialog({ blocks: without('onboarding') })
		expect(builtInOptions(shown.dialog)).toEqual(['Onboarding checklist'])
	})

	it('adds the picked block and closes', async () => {
		const { dialog, onAdd } = await openDialog({ blocks: without('stats') })
		await userEvent.click(
			within(dialog).getByRole('button', { name: /^Stats/ }),
		)
		expect(onAdd).toHaveBeenCalledExactlyOnceWith({ type: 'stats' })
		await waitFor(() =>
			expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
		)
	})

	it('explains the block limit instead of offering blocks on a full dashboard', async () => {
		const blocks: DashboardBlock[] = [
			...without('leaderboard'),
			...Array.from(
				{ length: MAX_DASHBOARD_BLOCKS - 3 },
				(_, index): DashboardBlock => ({
					id: `report-${index}`,
					type: 'report',
					config: { source: 'template', templateId: 'customer-count' },
				}),
			),
		]
		const renderSections = vi.fn(() => null)
		const { dialog } = await openDialog({ blocks, renderSections })
		expect(dialog).toHaveTextContent(
			`This dashboard has ${MAX_DASHBOARD_BLOCKS} blocks, the most it can have.`,
		)
		expect(within(dialog).queryByRole('group')).not.toBeInTheDocument()
		expect(renderSections).not.toHaveBeenCalled()
	})

	it('adds blocks picked in extra sections', async () => {
		const { dialog, onAdd } = await openDialog({
			renderSections: (select) => (
				<AddBlockSection title="Reports">
					<AddBlockOption
						title="Customer count"
						onSelect={() =>
							select({
								type: 'report',
								config: { source: 'template', templateId: 'customer-count' },
							})
						}
					/>
				</AddBlockSection>
			),
		})
		const reports = within(dialog).getByRole('group', { name: 'Reports' })
		await userEvent.click(
			within(reports).getByRole('button', { name: 'Customer count' }),
		)
		expect(onAdd).toHaveBeenCalledExactlyOnceWith({
			type: 'report',
			config: { source: 'template', templateId: 'customer-count' },
		})
	})
})
