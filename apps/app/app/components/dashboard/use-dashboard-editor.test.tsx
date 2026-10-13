// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import {
	createMemoryRouter,
	data,
	RouterProvider,
	type ActionFunctionArgs,
} from 'react-router'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	defaultHomeConfig,
	parseDashboardConfig,
	type DashboardConfig,
	type GridItem,
} from '#app/utils/dashboards/config.ts'
import { removeBlock } from '#app/utils/dashboards/layout.ts'
import { SAVE_DELAY_MS, useDashboardEditor } from './use-dashboard-editor.ts'

type Submission = Record<string, FormDataEntryValue>

const leaderboardFirst: GridItem[] = [
	{ i: 'leaderboard', x: 0, y: 0, w: 6, h: 10 },
	{ i: 'stats', x: 0, y: 10, w: 12, h: 2 },
	{ i: 'notes-chart', x: 0, y: 12, w: 12, h: 8 },
	{ i: 'onboarding', x: 0, y: 20, w: 6, h: 10 },
]

function Editor({ config }: { config: DashboardConfig }) {
	const editor = useDashboardEditor({ config, resetConfig: defaultHomeConfig })
	return (
		<div>
			<p data-testid="blocks">
				{editor.config.blocks.map((block) => block.id).join(' ')}
			</p>
			<p data-testid="status">
				{editor.saving ? 'saving' : editor.saved ? 'saved' : 'idle'}
			</p>
			<button type="button" onClick={editor.startEditing}>
				Edit
			</button>
			<button
				type="button"
				onClick={() => editor.commitLayout('lg', leaderboardFirst, [])}
			>
				Move
			</button>
			<button type="button" onClick={() => editor.removeBlock('onboarding')}>
				Remove
			</button>
			<button type="button" onClick={editor.stopEditing}>
				Done
			</button>
			<button type="button" onClick={() => editor.reset?.()}>
				Reset
			</button>
		</div>
	)
}

function renderEditor({
	config = defaultHomeConfig(),
	respond = () => ({ ok: true }),
}: {
	config?: DashboardConfig
	respond?: () => unknown
} = {}) {
	const submissions: Submission[] = []
	const submittedAt: number[] = []
	const action = vi.fn(async ({ request }: ActionFunctionArgs) => {
		submittedAt.push(performance.now())
		submissions.push(Object.fromEntries(await request.formData()))
		return respond()
	})
	const router = createMemoryRouter([
		{ path: '/', action, element: <Editor config={config} /> },
	])
	render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
	return { action, submissions, submittedAt }
}

function savedConfig(submission: Submission | undefined) {
	const result = parseDashboardConfig(String(submission?.config))
	if (!result.success) throw new Error(result.error.message)
	return result.config
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

describe('useDashboardEditor', () => {
	it('does not save anything when the dashboard loads', async () => {
		const { action } = renderEditor()
		await sleep(SAVE_DELAY_MS + 200)
		expect(action).not.toHaveBeenCalled()
		expect(screen.getByTestId('status')).toHaveTextContent('idle')
	})

	it('saves quick successive changes once, after they settle', async () => {
		const user = userEvent.setup()
		const { action, submissions } = renderEditor()
		await user.click(screen.getByRole('button', { name: 'Move' }))
		await user.click(screen.getByRole('button', { name: 'Remove' }))
		expect(action).not.toHaveBeenCalled()
		expect(screen.getByTestId('status')).toHaveTextContent('saving')

		await waitFor(() => expect(action).toHaveBeenCalledTimes(1), {
			timeout: 3000,
		})
		expect(submissions[0]?.intent).toBe('save-config')
		const saved = savedConfig(submissions[0])
		expect(saved.blocks.map((block) => block.id)).toEqual([
			'stats',
			'notes-chart',
			'leaderboard',
		])
		expect(saved.layouts.lg).toContainEqual({
			i: 'leaderboard',
			x: 0,
			y: 0,
			w: 6,
			h: 10,
		})
		await waitFor(() =>
			expect(screen.getByTestId('status')).toHaveTextContent('saved'),
		)

		await sleep(SAVE_DELAY_MS + 200)
		expect(action).toHaveBeenCalledTimes(1)
	})

	it('saves a waiting change at once when editing ends', async () => {
		const user = userEvent.setup()
		const { action, submittedAt } = renderEditor()
		await user.click(screen.getByRole('button', { name: 'Edit' }))
		await user.click(screen.getByRole('button', { name: 'Move' }))
		const doneAt = performance.now()
		await user.click(screen.getByRole('button', { name: 'Done' }))

		await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
		expect(submittedAt[0]! - doneAt).toBeLessThan(SAVE_DELAY_MS)
		await sleep(SAVE_DELAY_MS + 200)
		expect(action).toHaveBeenCalledTimes(1)
	})

	it('restores the saved dashboard and explains why when a save is rejected', async () => {
		const toastError = vi.spyOn(toast, 'error').mockReturnValue('toast')
		const user = userEvent.setup()
		renderEditor({
			respond: () =>
				data(
					{
						ok: false,
						error: { code: 'too-many-blocks', message: 'Too many blocks.' },
					},
					{ status: 400 },
				),
		})
		await user.click(screen.getByRole('button', { name: 'Remove' }))
		expect(screen.getByTestId('blocks')).toHaveTextContent(
			'stats notes-chart leaderboard',
		)

		await waitFor(
			() =>
				expect(toastError).toHaveBeenCalledWith(
					'A dashboard can have at most 30 blocks.',
				),
			{ timeout: 3000 },
		)
		expect(screen.getByTestId('blocks')).toHaveTextContent(
			'stats notes-chart onboarding leaderboard',
		)
	})

	it('resets to the default blocks at once and drops a waiting save', async () => {
		const user = userEvent.setup()
		const { submissions } = renderEditor({
			config: removeBlock(defaultHomeConfig(), 'leaderboard'),
		})
		expect(screen.getByTestId('blocks')).toHaveTextContent(
			'stats notes-chart onboarding',
		)
		await user.click(screen.getByRole('button', { name: 'Move' }))
		await user.click(screen.getByRole('button', { name: 'Reset' }))
		expect(screen.getByTestId('blocks')).toHaveTextContent(
			'stats notes-chart onboarding leaderboard',
		)

		await waitFor(() => expect(submissions).toEqual([{ intent: 'reset' }]))
		await sleep(SAVE_DELAY_MS + 200)
		expect(submissions).toEqual([{ intent: 'reset' }])
	})
})
