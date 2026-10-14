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
import { loadCatalog } from '#app/modules/lingui/lingui.ts'
import { type ReportBlockConfig } from '#app/utils/dashboards/config.ts'
import { type ReportBlockData } from '#app/utils/dashboards/reports.ts'
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
}: {
	savedReports?: ReportBlockData['savedReports']
} = {}): ReportBlockData {
	return {
		savedReports,
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

const emptyResult: ReportResult = {
	total: 0,
	segments: [],
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
		expect(
			screen.getByText(
				'This report was deleted. Remove the block or add another report.',
			),
		).toBeInTheDocument()
		expect(screen.queryByRole('link')).not.toBeInTheDocument()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('does not ask someone who cannot edit the dashboard to remove a deleted report', () => {
		mockFetch(() => json(countResult))
		render(
			<I18nProvider i18n={i18n}>
				<MemoryRouter>
					<ReportBlock
						config={{ source: 'saved', reportId: 'gone' }}
						orgSlug="acme"
						reports={reportData({ savedReports: { gone: null } })}
						editable={false}
					/>
				</MemoryRouter>
			</I18nProvider>,
		)
		expect(screen.getByText('Report not found')).toBeInTheDocument()
		expect(screen.getByText('This report was deleted.')).toBeInTheDocument()
		expect(screen.queryByText(/Remove the block/)).not.toBeInTheDocument()
	})

	it.each([403, 401])(
		'shows no access when the regional analytics token is refused with %i',
		async (status) => {
			const fetchMock = mockFetch((url) =>
				url === TOKEN_URL
					? new Response('Unauthorized: required permissions', { status })
					: json(countResult),
			)
			renderBlock(
				{ source: 'template', templateId: 'customer-count' },
				reportData(),
			)

			expect(await findResult('No access')).toBeInTheDocument()
			expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
				TOKEN_URL,
			])
		},
	)

	it('shows no access once permissions are revoked while the page stays open', async () => {
		let canGetToken = true
		const fetchMock = mockFetch((url) => {
			if (url !== TOKEN_URL) return json(countResult)
			return canGetToken
				? json({ token: 'token', tenantApiUrl: TENANT_API_URL })
				: new Response('Unauthorized: required permissions', { status: 403 })
		})
		const reports = reportData()
		const block: ReportBlockConfig = {
			source: 'template',
			templateId: 'customer-count',
		}
		const { unmount } = renderBlock(block, reports)
		expect(await findResult('42')).toBeInTheDocument()

		// The page data still comes from before the change; a block that
		// mounts again, as across a grid breakpoint, asks for a new token.
		canGetToken = false
		unmount()
		renderBlock(block, reports)

		expect(await findResult('No access')).toBeInTheDocument()
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			TOKEN_URL,
			`${TENANT_API_URL}/analytics/query`,
			TOKEN_URL,
		])
	})

	it('shows the report error when the token fails for another reason', async () => {
		mockFetch((url) =>
			url === TOKEN_URL
				? new Response('Internal Server Error', { status: 500 })
				: json(countResult),
		)
		renderBlock(
			{ source: 'template', templateId: 'customer-count' },
			reportData(),
		)
		expect(await findResult('Cannot run this report')).toBeInTheDocument()
		expect(screen.queryByText('No access')).not.toBeInTheDocument()
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
			reportData(),
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
		expect(
			within(container).getByText(
				'Its results could not be loaded. Try again later.',
			),
		).toBeInTheDocument()
		expect(within(container).queryByText('Failed to fetch')).toBeNull()
	})

	it('explains run errors by their code, as their messages are English only', async () => {
		mockFetch((url) =>
			url === TOKEN_URL
				? json({ token: 'token', tenantApiUrl: TENANT_API_URL })
				: json(
						{
							error: 'tenant_not_provisioned',
							message:
								'This organization has not provisioned a customer database.',
						},
						409,
					),
		)
		renderBlock(
			{ source: 'template', templateId: 'customer-count' },
			reportData(),
		)
		expect(await findResult('Cannot run this report')).toBeInTheDocument()
		expect(
			screen.getByText(
				'This organization does not have a customer database yet.',
			),
		).toBeInTheDocument()
	})

	it('shows the loading, empty and error states in the language of the page', async () => {
		await loadCatalog('ar')
		const savedNotes: ReportBlockConfig = { source: 'saved', reportId: 'r1' }
		const reports = reportData({
			savedReports: {
				r1: { title: 'All notes', definition: notesCount('All notes') },
			},
		})

		mockFetch(() => new Promise<Response>(() => {}))
		const loading = renderBlock(savedNotes, reports)
		expect(await findResult('جارٍ تحميل النتائج…')).toBeInTheDocument()
		loading.unmount()

		mockFetch(() => json(emptyResult))
		const empty = renderBlock(
			{ source: 'template', templateId: 'notes-by-status' },
			reportData(),
		)
		expect(await findResult('لا توجد سجلات مطابقة')).toBeInTheDocument()
		expect(
			screen.getByText(
				'لا يوجد في هذا الإطار الزمني ما يطابق عوامل تصفية التقرير.',
			),
		).toBeInTheDocument()
		empty.unmount()

		mockFetch(() => Promise.reject(new TypeError('Failed to fetch')))
		renderBlock(savedNotes, reports)
		expect(await findResult('تعذّر تشغيل هذا التقرير')).toBeInTheDocument()
		expect(
			screen.getByText('تعذّر تحميل نتائجه. حاول مرة أخرى لاحقًا.'),
		).toBeInTheDocument()
		expect(screen.queryByText('Cannot run this report')).toBeNull()
	})
})
