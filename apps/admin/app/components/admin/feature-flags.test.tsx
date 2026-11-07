/**
 * @vitest-environment jsdom
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRoutesStub } from 'react-router'
import { describe, expect, it } from 'vitest'
import { renderWithI18n as render } from '#tests/utils.tsx'
import { FeatureFlags } from './feature-flags.tsx'

const now = new Date('2026-01-01T00:00:00Z')

function renderFeatureFlags(
	respond: (form: FormData) => unknown = () => ({ ok: true }),
) {
	const sent: Array<Record<string, FormDataEntryValue>> = []
	const App = createRoutesStub([
		{
			path: '/feature-flags',
			Component: FeatureFlags,
			HydrateFallback: () => null,
			loader: () => ({
				flags: [
					{
						id: 'flag-1',
						key: 'beta.enabled',
						value: true,
						level: 'system' as const,
						organizationId: null,
						userId: null,
						createdAt: now,
						updatedAt: now,
					},
				],
			}),
			action: async ({ request }) => {
				const form = await request.formData()
				sent.push(Object.fromEntries(form))
				return respond(form)
			},
		},
	])
	return { sent, ...render(<App initialEntries={['/feature-flags']} />) }
}

async function openEditDialog() {
	const user = userEvent.setup()
	await user.click(await screen.findByRole('button', { name: 'Edit' }))
	return { user, dialog: await screen.findByRole('dialog') }
}

describe('FeatureFlags', () => {
	it('shows a page heading above the tabs', async () => {
		renderFeatureFlags()

		expect(
			await screen.findByRole('heading', { level: 1, name: 'Feature flags' }),
		).toBeInTheDocument()
	})

	it('renders each dialog trigger as a single button', async () => {
		const { container } = renderFeatureFlags()

		expect(
			await screen.findAllByRole('button', { name: 'Add Flag' }),
		).toHaveLength(1)
		expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1)
		expect(container.querySelector('button button')).toBeNull()
	})

	it('saves an edited boolean flag switched off with its key', async () => {
		const { sent } = renderFeatureFlags()
		const { user, dialog } = await openEditDialog()
		const toggle = within(dialog).getByRole('switch')
		expect(toggle).toBeChecked()

		await user.click(toggle)
		expect(toggle).not.toBeChecked()
		await user.click(
			within(dialog).getByRole('button', { name: 'Update Flag' }),
		)

		await waitFor(() => expect(sent).toHaveLength(1))
		expect(sent[0]).toMatchObject({
			_action: 'update',
			id: 'flag-1',
			key: 'beta.enabled',
			level: 'system',
			type: 'boolean',
			value: 'off',
		})
	})

	it('shows why the server refused the flag', async () => {
		renderFeatureFlags(() =>
			Response.json({ errors: { value: ['Required'] } }, { status: 400 }),
		)
		const { user, dialog } = await openEditDialog()

		await user.click(
			within(dialog).getByRole('button', { name: 'Update Flag' }),
		)

		expect(await within(dialog).findByRole('alert')).toHaveTextContent(
			'value: Required',
		)
		expect(screen.getByRole('dialog')).toBe(dialog)
	})
})
