// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	ReportSchedulesScreen,
	type ScheduleListItem,
} from './report-schedules-screen.tsx'

const base = {
	orgSlug: 'acme',
	enabled: true,
	defaultTimeZone: 'America/Chicago',
	limits: { schedules: 10, recipients: 20 },
	initialReport: null,
	members: [
		{ id: 'usr_1', name: 'Owner One', email: 'owner@example.com' },
		{ id: 'usr_2', name: null, email: 'manager@example.com' },
	],
	reports: [
		{ id: 'rep_ok', title: 'Net sales', personal: false },
		{ id: 'rep_pii', title: 'Orders with phones', personal: true },
	],
}

const schedule = (over: Partial<ScheduleListItem> = {}): ScheduleListItem => ({
	id: 'sch_1',
	title: 'Net sales',
	builtIn: null,
	savedReportId: 'rep_ok',
	cadence: 'daily',
	weekday: null,
	hour: 8,
	timeZone: 'America/Chicago',
	locale: 'en',
	pausedAt: null,
	pausedReason: null,
	lastSentAt: '2027-01-05T14:00:00.000Z',
	lastError: null,
	recipients: [
		{
			userId: 'usr_1',
			name: 'Owner One',
			email: 'owner@example.com',
			unsubscribed: false,
			lastStatus: 'sent',
		},
		{
			userId: 'usr_2',
			name: null,
			email: 'manager@example.com',
			unsubscribed: false,
			lastStatus: 'skipped_no_access',
		},
	],
	...over,
})

describe('ReportSchedulesScreen (#121)', () => {
	it('lists schedules with their time, recipients, last send and status', () => {
		renderStaff(<ReportSchedulesScreen {...base} schedules={[schedule()]} />)
		const row = screen.getByTestId('schedule-row-sch_1')
		expect(row).toHaveTextContent('Net sales')
		expect(row).toHaveTextContent('Every day at 08:00 (America/Chicago)')
		expect(row).toHaveTextContent('skipped: no access')
		expect(row).toHaveTextContent('Active')
	})

	it('shows a failed run and a schedule paused after failures', () => {
		renderStaff(
			<ReportSchedulesScreen
				{...base}
				schedules={[
					schedule({
						lastError: 'email_error',
						pausedAt: '2027-01-07T14:00:00.000Z',
						pausedReason: 'failures',
					}),
				]}
			/>,
		)
		expect(screen.getByTestId('schedule-error-sch_1')).toHaveTextContent(
			'Last error: email_error',
		)
		expect(screen.getByTestId('schedule-row-sch_1')).toHaveTextContent(
			'Paused after failures',
		)
		expect(screen.getByTestId('schedule-pause-sch_1')).toHaveTextContent(
			'Resume',
		)
	})

	it('explains that a report with customer details cannot be scheduled and blocks saving', async () => {
		renderStaff(
			<ReportSchedulesScreen
				{...base}
				schedules={[]}
				initialReport="rep_pii"
			/>,
		)
		expect(await screen.findByTestId('schedule-personal')).toHaveTextContent(
			'customer name, phone or email',
		)
		expect(screen.getByTestId('schedule-save')).toBeDisabled()
	})

	it('needs a recipient before it can be saved, and offers members only', async () => {
		renderStaff(
			<ReportSchedulesScreen
				{...base}
				schedules={[]}
				initialReport="daily_summary"
			/>,
		)
		const save = await screen.findByTestId('schedule-save')
		expect(save).toBeDisabled()
		expect(screen.getByTestId('schedule-recipient-usr_1')).toBeInTheDocument()
		expect(screen.getByTestId('schedule-recipient-usr_2')).toBeInTheDocument()
		fireEvent.click(screen.getByTestId('schedule-recipient-usr_1'))
		await waitFor(() =>
			expect(screen.getByTestId('schedule-save')).not.toBeDisabled(),
		)
	})

	it('says so when scheduled reports are not switched on', () => {
		renderStaff(
			<ReportSchedulesScreen {...base} enabled={false} schedules={[]} />,
		)
		expect(screen.getByTestId('schedules-off')).toBeInTheDocument()
		expect(screen.queryByTestId('schedule-new')).toBeNull()
	})

	it('stops offering new schedules at the cap', () => {
		renderStaff(
			<ReportSchedulesScreen
				{...base}
				limits={{ schedules: 1, recipients: 20 }}
				schedules={[schedule()]}
			/>,
		)
		expect(screen.getByTestId('schedule-new')).toBeDisabled()
	})
})
