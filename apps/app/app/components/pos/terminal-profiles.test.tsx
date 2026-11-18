// @vitest-environment jsdom

import { DEFAULT_TERMINAL_SETTINGS } from '@repo/common/terminal-profiles'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	TerminalProfilesPanel,
	TerminalProfileSection,
	type TerminalProfile,
} from './terminal-profiles.tsx'

afterEach(() => cleanup())

const profile = (over: Partial<TerminalProfile> = {}): TerminalProfile => ({
	id: 'p1',
	name: 'Counter',
	settings: { ...DEFAULT_TERMINAL_SETTINGS, idleLockSeconds: 300 },
	version: 1,
	terminalCount: 0,
	pendingCodeCount: 0,
	updatedAt: 0,
	...over,
})

describe('TerminalProfilesPanel', () => {
	it('will not offer to delete a profile that is in use, and deletes one that is not', async () => {
		const request = vi.fn(async () => ({ ok: true }))
		const reload = vi.fn()
		renderStaff(
			<TerminalProfilesPanel
				canWrite
				locations={[]}
				request={request}
				reload={reload}
				profiles={[
					profile({ id: 'used', name: 'Bar', terminalCount: 2 }),
					profile({ id: 'free', name: 'Spare' }),
				]}
			/>,
		)
		const buttons = screen.getAllByRole('button', { name: 'Delete' })
		expect(buttons[0]).toBeDisabled()
		expect(buttons[1]).toBeEnabled()
		expect(screen.getByText('2 terminals')).toBeTruthy()
		fireEvent.click(buttons[1]!)
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith('/profiles/free', {
				method: 'DELETE',
			}),
		)
		await waitFor(() => expect(reload).toHaveBeenCalled())
	})

	it('hides every control from a member who cannot write', () => {
		renderStaff(
			<TerminalProfilesPanel
				canWrite={false}
				locations={[]}
				request={vi.fn()}
				reload={vi.fn()}
				profiles={[profile()]}
			/>,
		)
		expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'New profile' })).toBeNull()
	})
})

describe('TerminalProfileSection', () => {
	const device = (over: Record<string, unknown> = {}) => ({
		...DEFAULT_TERMINAL_SETTINGS,
		id: 'd1',
		locationId: null,
		profileId: 'p1',
		overrides: [] as never[],
		...over,
	})

	it('shows an overridden setting as overridden and lets the owner go back to the profile', async () => {
		const request = vi.fn(async () => ({ ok: true }))
		renderStaff(
			<TerminalProfileSection
				device={device({
					idleLockSeconds: 600,
					overrides: ['idleLockSeconds'],
				})}
				profiles={[profile()]}
				canWrite
				request={request}
				reload={vi.fn()}
			/>,
		)
		expect(screen.getByText('Overridden on this terminal:')).toBeTruthy()
		// Named in the list and badged next to the setting itself.
		expect(screen.getAllByText('Lock after').length).toBeGreaterThan(0)
		expect(screen.getAllByText('Overridden').length).toBeGreaterThan(0)
		fireEvent.click(
			screen.getByRole('button', { name: "Use the profile's values" }),
		)
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith('/terminals/d1', {
				method: 'PATCH',
				body: JSON.stringify({ resetOverrides: 'all' }),
			}),
		)
	})

	it('shows nothing as overridden when the terminal follows its profile', () => {
		renderStaff(
			<TerminalProfileSection
				device={device()}
				profiles={[profile()]}
				canWrite
				request={vi.fn()}
				reload={vi.fn()}
			/>,
		)
		expect(screen.queryByText('Overridden on this terminal:')).toBeNull()
		expect(screen.queryByText('Overridden')).toBeNull()
	})

	it('does not call a setting overridden when the terminal has no profile', () => {
		renderStaff(
			<TerminalProfileSection
				device={device({ profileId: null, overrides: ['idleLockSeconds'] })}
				profiles={[profile()]}
				canWrite
				request={vi.fn()}
				reload={vi.fn()}
			/>,
		)
		expect(screen.queryByText('Overridden')).toBeNull()
	})
})
