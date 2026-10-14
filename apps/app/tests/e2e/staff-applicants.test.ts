import { type Page } from '@playwright/test'
import { ConfigFlag, db, eq, OrganizationLocation } from '@repo/database'
import { STAFFING_FLAG_KEYS } from '@repo/staffing'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

/**
 * Applicants (flag `staffing.hiring`): the pipeline board and list, the
 * candidate sheet, and the decline and hire steps. The regional tenant-api is
 * not part of this test environment, so `/operator/hiring` is stubbed in the
 * browser with the response shapes the screens parse; the App's own routes
 * (flags, token mint, loaders, UI) are real. Run against the `CI=true` mocked
 * build, like the other manager specs.
 */

const SCREENSHOTS = 'test-results/staff-applicants'
const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'authorization, content-type',
	'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
}

type StubRequest = { method: string; path: string; body: any }

async function enableHiring(organizationId: string) {
	const ids: string[] = []
	for (const feature of ['enabled', 'hiring'] as const) {
		const [row] = await db
			.insert(ConfigFlag)
			.values({
				key: STAFFING_FLAG_KEYS[feature],
				value: true,
				level: 'organization',
				organizationId,
			})
			.returning({ id: ConfigFlag.id })
		ids.push(row!.id)
	}
	return ids
}

async function dropFlags(ids: string[]) {
	for (const id of ids) await db.delete(ConfigFlag).where(eq(ConfigFlag.id, id))
}

function json(route: any, data: unknown, status = 200) {
	return route.fulfill({
		status,
		headers: { ...CORS, 'content-type': 'application/json' },
		body: JSON.stringify(data),
	})
}

function summary(
	id: string,
	firstName: string,
	scopeId: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		postingId: 'p1',
		postingTitle: 'Line cook',
		scopeId,
		firstName,
		lastName: 'Ali',
		source: 'careers_page',
		stage: 'new',
		stageChangedAt: Date.now() - 3_600_000,
		screenerScore: 100,
		flagCount: 0,
		hasEmail: true,
		hasPhone: false,
		interviewAt: null,
		noteCount: 0,
		hiredStaffId: null,
		createdAt: Date.now() - 3_600_000,
		...overrides,
	}
}

async function stubHiringApi(page: Page, scopeId: string) {
	const requests: StubRequest[] = []
	const applicants = [
		summary('a1', 'Amira', scopeId, { flagCount: 1, screenerScore: 40 }),
		summary('a2', 'Bilal', scopeId, { stage: 'screening' }),
		summary('a3', 'Carla', scopeId, { stage: 'interview' }),
	]
	const detailOf = (id: string) => {
		const { hasEmail, hasPhone, noteCount, interviewAt, ...base } =
			applicants.find((a) => a.id === id)!
		void hasEmail
		void hasPhone
		void noteCount
		void interviewAt
		return {
			...base,
			email: 'amira@example.com',
			phone: null,
			locale: 'en',
			positionName: 'Line cook',
			answers: [
				{
					id: 'weekends',
					kind: 'yes_no',
					prompt: 'Can you work weekends?',
					answer: 'no',
					requiredAnswer: 'yes',
					dealbreaker: true,
				},
			],
			flags: ['weekends'],
			declinedReason: null,
			declinedAt: null,
			consentAt: Date.now() - 3_600_000,
			consentVersion: '2026-10',
			retentionExpiresAt: null,
			declineRetentionDays: 365,
			hiredAt: null,
			notes: [],
			interviews: [],
			timeline: [],
		}
	}
	const counts = () => {
		const c: Record<string, number> = {
			new: 0,
			screening: 0,
			interview: 0,
			offer: 0,
			hired: 0,
			declined: 0,
		}
		for (const a of applicants) c[a.stage] = (c[a.stage] ?? 0) + 1
		return c
	}

	await page.route('**/operator/hiring/**', async (route) => {
		const request = route.request()
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const url = new URL(request.url())
		const path = url.pathname.replace(/^.*\/operator\/hiring/, '') || '/'
		const method = request.method()
		const body = request.postDataJSON?.() ?? null
		requests.push({ method, path, body })

		if (method === 'GET' && path === '/applications') {
			const open = applicants.filter((a) =>
				['new', 'screening', 'interview', 'offer'].includes(a.stage),
			)
			return json(route, {
				applications: open,
				counts: counts(),
				postings: [{ postingId: 'p1', title: 'Line cook', count: 3 }],
				total: open.length,
			})
		}
		const stage = path.match(/^\/applications\/([^/]+)\/stage$/)
		if (method === 'POST' && stage) {
			const found = applicants.find((a) => a.id === stage[1])!
			found.stage = body.stage
			return json(route, { application: found })
		}
		const decline = path.match(/^\/applications\/([^/]+)\/decline$/)
		if (method === 'POST' && decline) {
			const found = applicants.find((a) => a.id === decline[1])!
			found.stage = 'declined'
			return json(route, { application: found, email: 'sent' })
		}
		const one = path.match(/^\/applications\/([^/]+)$/)
		if (method === 'GET' && one) return json(route, detailOf(one[1]!))
		return json(route, { error: 'Not found' }, 404)
	})
	return { requests, applicants }
}

async function createOrgWithLocation(userId: string) {
	const org = await createTestOrganization(userId, 'admin')
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: org.id,
			name: 'Downtown',
			slug: `downtown-${Date.now()}`,
			timezone: 'America/Chicago',
		})
		.returning({ id: OrganizationLocation.id })
	return { org, scopeId: location!.id }
}

test.describe('Applicants (manager)', () => {
	test('is not found while hiring is off', async ({ login, navigate }) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const response = await navigate('/:slug/staff/hiring/applicants', {
			slug: org.slug,
		})
		expect(response?.status()).toBe(404)
	})

	test('shows the board, opens a candidate in a sheet and moves a card from its menu', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithLocation(user.id)
		const flags = await enableHiring(org.id)
		const { requests } = await stubHiringApi(page, scopeId)
		try {
			await page.setViewportSize({ width: 1280, height: 800 })
			await navigate('/:slug/staff/hiring/applicants', { slug: org.slug })
			await expect(
				page.getByRole('heading', { name: 'Applicants', exact: true }),
			).toBeVisible()
			await expect(page.getByRole('link', { name: 'Amira Ali' })).toBeVisible()
			// A flag is said in words, and no contact detail is on the board.
			await expect(page.getByText('1 answer to check')).toBeVisible()
			await expect(page.getByText('amira@example.com')).toHaveCount(0)
			await page.screenshot({ path: `${SCREENSHOTS}/board-desktop.png` })

			// Move a card with the menu (the keyboard and touch way).
			await page
				.getByRole('button', { name: 'Move Amira Ali to another stage' })
				.click()
			await page.getByRole('menuitem', { name: 'Offer' }).click()
			await expect
				.poll(() =>
					requests.some(
						(r) => r.method === 'POST' && r.path === '/applications/a1/stage',
					),
				)
				.toBe(true)
			const move = requests.find((r) => r.path === '/applications/a1/stage')!
			expect(move.body).toEqual({ stage: 'offer' })

			// A candidate opens by its own link, with their details and answers.
			await page.getByRole('link', { name: 'Bilal Ali' }).click()
			await expect(page.getByText('Can you work weekends?')).toBeVisible()
			await expect(
				page.getByRole('link', { name: 'amira@example.com' }),
			).toBeVisible()
			await expect(
				page.getByText('Wanted: Yes. This one matters for the job.'),
			).toBeVisible()
			await page.screenshot({ path: `${SCREENSHOTS}/candidate-desktop.png` })
		} finally {
			await dropFlags(flags)
		}
	})

	test('declines a candidate with a reason and a message, on a phone', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const { org, scopeId } = await createOrgWithLocation(user.id)
		const flags = await enableHiring(org.id)
		const { requests } = await stubHiringApi(page, scopeId)
		try {
			await page.setViewportSize({ width: 390, height: 844 })
			await navigate('/:slug/staff/hiring/applicants', { slug: org.slug })
			// A phone gets the list, not the columns.
			await expect(page.getByRole('link', { name: 'Amira Ali' })).toBeVisible()
			await expect(
				page.getByRole('region', { name: /^Screening/ }),
			).toHaveCount(0)
			await page.screenshot({ path: `${SCREENSHOTS}/list-mobile.png` })

			await page.getByRole('link', { name: 'Amira Ali' }).click()
			// Wait for the candidate sheet: until it opens, the only button whose
			// name contains "Decline" is the "Declined" stage filter.
			const sheet = page.getByRole('dialog')
			await expect(sheet).toBeVisible()
			await sheet.getByRole('button', { name: 'Decline', exact: true }).click()
			const dialog = page.getByRole('dialog').last()
			await expect(dialog.getByText('Decline Amira Ali')).toBeVisible()
			await expect(dialog.getByText(/removed after 365 days/)).toBeVisible()
			await page.screenshot({ path: `${SCREENSHOTS}/decline-mobile.png` })
			await dialog.getByRole('button', { name: 'Decline', exact: true }).click()
			await expect
				.poll(() =>
					requests.some(
						(r) => r.method === 'POST' && r.path === '/applications/a1/decline',
					),
				)
				.toBe(true)
			const decline = requests.find(
				(r) => r.path === '/applications/a1/decline',
			)!
			expect(decline.body).toEqual({ reason: 'not_a_fit', template: 'thanks' })
		} finally {
			await dropFlags(flags)
		}
	})
})
