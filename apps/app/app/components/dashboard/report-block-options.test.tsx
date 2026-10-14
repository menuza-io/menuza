// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	defaultHomeConfig,
	type DashboardBlock,
} from '#app/utils/dashboards/config.ts'
import {
	reportTemplateGroups,
	type SavedReportOption,
} from '#app/utils/dashboards/reports.ts'
import { AddBlockDialog } from './add-block-dialog.tsx'
import { ReportBlockOptions } from './report-block-options.tsx'

const savedReports: SavedReportOption[] = [
	{ id: 'r1', title: 'Weekly notes', subjectLabel: 'Notes' },
	{ id: 'r2', title: 'Big orders', subjectLabel: 'Shop orders' },
]

async function openDialog({
	blocks = defaultHomeConfig().blocks,
	reports = savedReports,
}: { blocks?: DashboardBlock[]; reports?: SavedReportOption[] } = {}) {
	const onAdd = vi.fn()
	const picker = {
		onboardingAvailable: false,
		savedReports: reports,
		templateGroups: reportTemplateGroups(),
	}
	render(
		<I18nProvider i18n={i18n}>
			<AddBlockDialog
				blocks={blocks}
				picker={picker}
				onAdd={onAdd}
				renderSections={(select) => (
					<ReportBlockOptions
						savedReports={picker.savedReports}
						templateGroups={picker.templateGroups}
						onSelect={select}
					/>
				)}
			/>
		</I18nProvider>,
	)
	await userEvent.click(screen.getByRole('button', { name: 'Add block' }))
	return { onAdd, dialog: await screen.findByRole('dialog') }
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

describe('ReportBlockOptions', () => {
	it('lists the saved reports by title with their subject', async () => {
		const { dialog, onAdd } = await openDialog()
		const saved = within(dialog).getByRole('group', { name: 'Saved reports' })
		const options = within(saved).getAllByRole('button')
		expect(options.map((option) => option.textContent)).toEqual([
			'Weekly notesNotes',
			'Big ordersShop orders',
		])
		expect(options[0]).toHaveAccessibleDescription('Notes')

		await userEvent.click(options[1]!)
		expect(onAdd).toHaveBeenCalledExactlyOnceWith({
			type: 'report',
			config: { source: 'saved', reportId: 'r2' },
		})
	})

	it('still offers a saved report that is already on the dashboard', async () => {
		const { dialog } = await openDialog({
			blocks: [
				...defaultHomeConfig().blocks,
				{
					id: 'report-1',
					type: 'report',
					config: { source: 'saved', reportId: 'r1' },
				},
			],
		})
		expect(
			within(dialog).getByRole('button', { name: /^Weekly notes/ }),
		).toBeInTheDocument()
	})

	it('points to the Reports page when nothing is saved yet', async () => {
		const { dialog } = await openDialog({ reports: [] })
		const saved = within(dialog).getByRole('group', { name: 'Saved reports' })
		expect(within(saved).queryByRole('button')).not.toBeInTheDocument()
		expect(saved).toHaveTextContent(
			'Reports you save on the Reports page appear here.',
		)
	})

	it('groups the report templates by category', async () => {
		const { dialog, onAdd } = await openDialog()
		const templates = within(dialog).getByRole('group', {
			name: 'Report templates',
		})
		const groups = reportTemplateGroups()
		const categories = within(templates).getAllByRole('group')
		expect(categories).toHaveLength(groups.length)
		for (const [index, group] of groups.entries()) {
			const category = within(templates).getByRole('group', {
				name: group.category,
			})
			expect(category).toBe(categories[index])
			expect(
				within(category)
					.getAllByRole('button')
					.map((button) => button.firstElementChild?.textContent),
			).toEqual(group.templates.map((template) => template.title))
		}

		const notes = within(templates).getByRole('group', { name: 'Notes' })
		await userEvent.click(
			within(notes).getByRole('button', { name: /^Notes by status/ }),
		)
		expect(onAdd).toHaveBeenCalledExactlyOnceWith({
			type: 'report',
			config: { source: 'template', templateId: 'notes-by-status' },
		})
	})
})
