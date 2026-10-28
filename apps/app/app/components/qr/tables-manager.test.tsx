// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { TablesManager } from './tables-manager.tsx'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock('#app/hooks/use-qr-client.ts', () => ({
	useQrClient: () => mocks.request,
}))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

describe('TablesManager', () => {
	it('never shows a slow failure for the previous location under the new one', async () => {
		let failFirst: (reason: unknown) => void = () => {}
		mocks.request.mockImplementation((path: string) =>
			path.includes('loc-1')
				? new Promise((_, reject) => {
						failFirst = reject
					})
				: Promise.resolve({ tables: [] }),
		)
		render(
			<I18nProvider i18n={i18n}>
				<TablesManager
					orgSlug="acme"
					locations={[
						{ id: 'loc-1', name: 'Main' },
						{ id: 'loc-2', name: 'Harbor' },
					]}
					canWrite={false}
					floorPlanAvailable={false}
					printHref={null}
				/>
			</I18nProvider>,
		)
		await userEvent.selectOptions(screen.getByLabelText('Location'), 'loc-2')
		expect(await screen.findByText('No tables yet')).toBeTruthy()

		await act(async () => {
			failFirst(new Error('slow region'))
			await Promise.resolve()
		})
		expect(screen.queryByRole('alert')).toBeNull()
		expect(screen.getByText('No tables yet')).toBeTruthy()
	})
})
