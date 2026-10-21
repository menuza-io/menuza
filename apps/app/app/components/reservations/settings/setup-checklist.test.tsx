// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { describeSetupIssues } from '#app/utils/reservations/setup-progress.ts'
import {
	deriveSetupSteps,
	summarizeSetupStatus,
} from '#app/utils/reservations/setup-progress.ts'
import { SetupChecklist } from './setup-checklist.tsx'
import { SetupDiagnostics, SetupStatusBadge } from './setup-diagnostics.tsx'

const input = {
	serviceCount: 1,
	tableCount: 0,
	enabledMessageCount: 2,
	settingsVersion: 2,
	rulesReviewed: false,
	bookingTested: false,
	issues: [],
}

describe('SetupChecklist', () => {
	it('shows progress and a Go link on the next step', () => {
		const onGo = vi.fn()
		renderStaff(
			<SetupChecklist
				steps={deriveSetupSteps(input)}
				orgSlug="acme"
				search="?location=l1"
				dismissed={false}
				onGo={onGo}
				onDismiss={vi.fn()}
			/>,
		)
		expect(screen.getByTestId('setup-checklist-progress').textContent).toMatch(
			/3 of 5/,
		)
		const go = screen.getByTestId('setup-step-go-tables')
		expect(go.getAttribute('href')).toBe(
			'/acme/reservations/settings/tables?location=l1',
		)
		fireEvent.click(go)
		expect(onGo).toHaveBeenCalledWith('tables')
	})

	it('collapses to a dismissible line when complete', () => {
		const onDismiss = vi.fn()
		renderStaff(
			<SetupChecklist
				steps={deriveSetupSteps({
					...input,
					tableCount: 3,
					bookingTested: true,
				})}
				orgSlug="acme"
				search=""
				dismissed={false}
				onGo={vi.fn()}
				onDismiss={onDismiss}
			/>,
		)
		fireEvent.click(screen.getByTestId('setup-checklist-dismiss'))
		expect(onDismiss).toHaveBeenCalled()
	})
})

describe('SetupStatusBadge and SetupDiagnostics', () => {
	it('never says ready when something blocks booking', () => {
		const status = summarizeSetupStatus([], { noTables: true })
		renderStaff(
			<>
				<SetupStatusBadge status={status} loading={false} />
				<SetupDiagnostics
					items={describeSetupIssues([], new Map(), { noTables: true })}
					status={status}
					loading={false}
					search=""
				/>
			</>,
		)
		expect(
			screen.getByTestId('setup-validation-status-badge').textContent,
		).toMatch(/Needs attention/)
		expect(screen.queryByText(/Ready to take bookings/)).toBeNull()
		expect(screen.getByText('Fix').getAttribute('href')).toContain('tables')
	})

	it('shows a skeleton, not a status, while loading', () => {
		renderStaff(<SetupStatusBadge status={null} loading />)
		expect(screen.queryByTestId('setup-validation-status-badge')).toBeNull()
		expect(screen.getByTestId('setup-validation-status-skeleton')).toBeTruthy()
	})
})
