// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	createReportDefinition,
	emptyFilterGroup,
	type ReportDefinition,
	type ReportResult,
} from '@repo/reports'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ReportBlockConfig } from '#app/utils/dashboards/config.ts'
import {
	type ReportBlockData,
	type ReportViewerAccess,
} from '#app/utils/dashboards/reports.ts'
import { ReportBlock } from './report-block.tsx'

const RUN_URL = '/acme/reports/run'
const TOKEN_URL = '/acme/reports/token'
const TENANT_API_URL = 'http://localhost:3007'

function notesCount(title: string): ReportDefinition {
	return createReportDefinition({
		subject: 'notes',
		timeframe: { field: 'createdAt', preset: 'all_time' },
		groupBy: [],
		timeBucket: 'month',
		columns: [],
		filters: emptyFilterGroup(),
		visualization: {
			chartStyle: 'single_number',
			measure: 'count',
			sortBy: 'none',
			hideCounts: false,
		},
		settings: { title, notes: '', timezone: 'user' },
	})
}

function reportData({
	savedReports = {},
	access = { tenant: true, phoneCalls: true },
}: {
	savedReports?: ReportBlockData['savedReports']
	access?: ReportViewerAccess
} = {}): ReportBlockData {
	return {
		savedReports,
		access,
		runUrl: RUN_URL,
		tokenUrl: TOKEN_URL,
		tenantApiUrl: TENANT_API_URL,
	}
}

const countResult: ReportResult = {
	total: 42,
	segments: [{ key: 'all', label: 'Notes', count: 42, percent: 100 }],
	refreshedAt: new Date(0).toISOString(),
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function mockFetch(respond: (url: string) => Response | Promise<Response>) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
		respond(String(input)),
	)
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

/** Results wait for the lazily loaded charts chunk on first use. */
function findResult(text: string) {
	return screen.findByText(text, undefined, { timeout: 5000 })
}

function renderBlock(
	config: ReportBlockConfig,
	reports: ReportBlockData | null,
	savedReportOptions = [] as Parameters<
		typeof ReportBlock
	>[0]['savedReportOptions'],
) {
	return render(
		<I18nProvider i18n={i18n}>
			<MemoryRouter>
				<ReportBlock
					config={config}
					orgSlug="acme"
					reports={reports}
					savedReportOptions={savedReportOptions}
				/>
			</MemoryRouter>
		</I18nProvider>,
	)
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('ReportBlock', () => {
	it('runs a saved control-plane report through the App and shows its number', async () => {
		const fetchMock = mockFetch(() => json(countResult))
		renderBlock(
			{ source: 'saved', reportId: 'r1' },
			reportData({
				savedReports: {
					r1: { title: 'All notes', definition: notesCount('All notes') },
				},
			}),
		)

		expect(screen.getByText('All notes')).toBeInTheDocument()
		expect(screen.getByText('Notes')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Open report' })).toHaveAttribute(
			'href',
			'/acme/reports/r1',
		)
		expect(await findResult('42')).toBeInTheDocument()
		expect(fetchMock).toHaveBeenCalledOnce()
		expect(fetchMock.mock.calls[0]?.[0]).toBe(RUN_URL)
	})

	it('opens a template in the report builder', () => {
		mockFetch(() => new Promise<Response>(() => {}))
		renderBlock(
			{ source: 'template', templateId: 'notes-by-status' },
			reportData(),
		)
		expect(screen.getByText('Notes by status')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Open report' })).toHaveAttribute(
			'href',
			'/acme/reports/new?template=notes-by-status',
		)
	})

	it('waits for report data of a block added since the page loaded', () => {
		const fetchMock = mockFetch(() => json(countResult))
		renderBlock({ source: 'saved', reportId: 'r2' }, null, [
			{ id: 'r2', title: 'New report', subjectLabel: 'Members' },
		])
		expect(screen.getByText('New report')).toBeInTheDocument()
		expect(screen.getByText('Members')).toBeInTheDocument()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('says a deleted saved report was not found', () => {
		const fetchMock = mockFetch(() => json(countResult))
		renderBlock(
			{ source: 'saved', reportId: 'gone' },
			reportData({ savedReports: { gone: null } }),
		)
		expect(screen.getByText('Report not found')).toBeInTheDocument()
		expect(screen.queryByRole('link')).not.toBeInTheDocument()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('shows no access when the viewer cannot get a regional analytics token', async () => {
		const fetchMock = mockFetch((url) =>
			url === TOKEN_URL
				? new Response('Unauthorized: required permissions', { status: 403 })
				: json(countResult),
		)
		renderBlock(
			{ source: 'template', templateId: 'customer-count' },
			reportData({ access: { tenant: false, phoneCalls: false } }),
		)

		expect(await findResult('No access')).toBeInTheDocument()
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			TOKEN_URL,
		])
	})

	it('shows no access when tenant-api refuses call reports', async () => {
		mockFetch((url) =>
			url === TOKEN_URL
				? json({ token: 'token', tenantApiUrl: TENANT_API_URL })
				: json(
						{
							error: 'forbidden_subject',
							message: 'You do not have permission to report on this data.',
						},
						403,
					),
		)
		renderBlock(
			{ source: 'template', templateId: 'phone-calls-by-week' },
			reportData({ access: { tenant: true, phoneCalls: false } }),
		)
		expect(await findResult('No access')).toBeInTheDocument()
	})

	it('shows a readable error inside the block when the report cannot run', async () => {
		mockFetch(() => Promise.reject(new TypeError('Failed to fetch')))
		const { container } = renderBlock(
			{ source: 'saved', reportId: 'r1' },
			reportData({
				savedReports: {
					r1: { title: 'All notes', definition: notesCount('All notes') },
				},
			}),
		)
		expect(await findResult('Cannot run this report')).toBeInTheDocument()
		expect(within(container).getByText('Failed to fetch')).toBeInTheDocument()
	})
})
