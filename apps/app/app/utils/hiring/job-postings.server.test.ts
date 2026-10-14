import { faker } from '@faker-js/faker'
import { db, JobPosting, Organization, User, eq } from '@repo/database'
import { DEFAULT_SCOPE_ID } from '@repo/staffing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const audit = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('@repo/audit', () => ({
	AuditAction: {
		JOB_POSTING_CREATED: 'job_posting_created',
		JOB_POSTING_UPDATED: 'job_posting_updated',
		JOB_POSTING_PUBLISHED: 'job_posting_published',
		JOB_POSTING_CLOSED: 'job_posting_closed',
		JOB_POSTING_DELETED: 'job_posting_deleted',
	},
	auditService: audit,
}))

import {
	changeJobPostingStatus,
	createJobPosting,
	deleteJobPosting,
	expireJobPostings,
	generalApplicationInput,
	getIntakePosting,
	getJobPosting,
	getPublicJobPosting,
	listJobPostings,
	listPublicJobPostings,
	updateJobPosting,
	type PostingActorScope,
} from './job-postings.server.ts'

const NOW = new Date('2026-10-13T12:00:00Z')

async function makeUser() {
	const [user] = await db
		.insert(User)
		.values({
			email: faker.internet.email().toLowerCase(),
			username: `u${faker.string.alphanumeric(10).toLowerCase()}`,
		})
		.returning()
	return user!.id
}

async function makeOrg() {
	const [org] = await db
		.insert(Organization)
		.values({
			name: faker.company.name(),
			slug: `jp-${faker.string.alphanumeric(10).toLowerCase()}`,
		})
		.returning()
	return org!.id
}

const content = {
	title: 'Line cook',
	positionName: 'Cook',
	employmentType: 'full_time',
	descriptionHtml: '<p>Cook on the line during busy dinner service.</p>',
}

let organizationId: string
let userId: string
let scope: PostingActorScope

beforeEach(async () => {
	audit.log.mockReset()
	organizationId = await makeOrg()
	userId = await makeUser()
	scope = { organizationId, userId }
})

async function create(input: Record<string, unknown> = {}, who = scope) {
	const result = await createJobPosting(who, { ...content, ...input })
	if (!result.ok) throw new Error(`create failed: ${result.error}`)
	return result.value
}

describe('createJobPosting', () => {
	it('creates a draft with a slug, sanitized text and an audit row', async () => {
		const posting = await create({
			title: 'Line <b>cook</b>',
			descriptionHtml:
				'<p>Cook <script>alert(1)</script>with us at least thirty characters.</p>',
		})
		expect(posting.status).toBe('draft')
		expect(posting.slug).toBe('line-cook')
		expect(posting.title).toBe('Line cook')
		expect(posting.descriptionHtml).not.toContain('script')
		expect(audit.log).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'job_posting_created',
				organizationId,
				resourceType: 'job_posting',
			}),
		)
		// Ids and states only.
		const metadata = audit.log.mock.calls[0]![0].metadata
		expect(JSON.stringify(metadata)).not.toMatch(/Line|Cook/)
	})

	it('gives a duplicate title a unique slug within the organization only', async () => {
		const first = await create()
		const second = await create()
		expect([first.slug, second.slug]).toEqual(['line-cook', 'line-cook-2'])
		const otherOrg = await makeOrg()
		const other = await create({}, { organizationId: otherOrg, userId })
		expect(other.slug).toBe('line-cook')
	})

	it('rejects invalid input and names the fields', async () => {
		const result = await createJobPosting(scope, {
			...content,
			title: 'x',
			payType: 'hourly',
		})
		expect(result).toMatchObject({ ok: false, error: 'invalid_input' })
		expect((result as { fields: string[] }).fields).toEqual(
			expect.arrayContaining(['title', 'payMinMinor']),
		)
	})

	it('stores no pay amounts when pay is not shown', async () => {
		const posting = await create({
			payType: 'none',
			payMinMinor: 1500,
			payMaxMinor: 2500,
		})
		expect(posting.payMinMinor).toBeNull()
		expect(posting.payMaxMinor).toBeNull()
	})

	it('refuses a description that stays too long after cleaning', async () => {
		const long = `<p>${'a'.repeat(21_000)}</p>`
		expect(
			await createJobPosting(scope, { ...content, descriptionHtml: long }),
		).toEqual({ ok: false, error: 'description_too_long' })
	})

	it('offers one General application that never expires', async () => {
		const result = await createJobPosting(
			scope,
			{ ...generalApplicationInput('USD'), closesOn: '2026-12-31' },
			{ general: true },
		)
		expect(result.ok && result.value.slug).toBe('general-application')
		expect(result.ok && result.value.closesOn).toBeNull()
		expect(result.ok && result.value.isGeneral).toBe(true)
		expect(
			await createJobPosting(scope, generalApplicationInput('USD'), {
				general: true,
			}),
		).toEqual({ ok: false, error: 'invalid_transition' })
	})
})

describe('reading', () => {
	it('never returns another organization’s posting by id', async () => {
		const posting = await create()
		const otherOrg = await makeOrg()
		const other = { organizationId: otherOrg, userId }
		expect(await getJobPosting(other, posting.id)).toBeNull()
		expect(await updateJobPosting(other, posting.id, content)).toEqual({
			ok: false,
			error: 'not_found',
		})
		expect(
			await changeJobPostingStatus(other, posting.id, 'published'),
		).toEqual({
			ok: false,
			error: 'not_found',
		})
		expect(await deleteJobPosting(other, posting.id)).toEqual({
			ok: false,
			error: 'not_found',
		})
		expect(await listJobPostings(other)).toEqual([])
		expect(await getJobPosting(scope, posting.id)).not.toBeNull()
	})

	it('treats an oversized or empty id as missing', async () => {
		expect(await getJobPosting(scope, '')).toBeNull()
		expect(await getJobPosting(scope, 'x'.repeat(100))).toBeNull()
	})
})

describe('updateJobPosting', () => {
	it('re-sanitizes and keeps the slug once it has been shared', async () => {
		const posting = await create()
		const live = await changeJobPostingStatus(scope, posting.id, 'published', {
			now: NOW,
		})
		expect(live.ok && live.value.status).toBe('published')
		const result = await updateJobPosting(scope, posting.id, {
			...content,
			title: 'Head chef',
			descriptionHtml:
				'<p onclick="x()">Lead the kitchen with passion every day.</p>',
		})
		expect(result.ok && result.value.slug).toBe('line-cook')
		expect(result.ok && result.value.descriptionHtml).toBe(
			'<p>Lead the kitchen with passion every day.</p>',
		)
	})

	it('renames the address of a draft that was never shared', async () => {
		const posting = await create()
		const result = await updateJobPosting(scope, posting.id, {
			...content,
			title: 'Head chef',
		})
		expect(result.ok && result.value.slug).toBe('head-chef')
	})

	it('does not let a live posting be edited into an unpublishable one', async () => {
		const posting = await create()
		await changeJobPostingStatus(scope, posting.id, 'published', { now: NOW })
		const result = await updateJobPosting(scope, posting.id, {
			...content,
			descriptionHtml: '<p>Short</p>',
		})
		expect(result).toMatchObject({
			ok: false,
			error: 'cannot_publish',
			reasons: ['description'],
		})
	})
})

describe('lifecycle', () => {
	it('publishes, closes, reopens and deletes', async () => {
		const posting = await create()
		const published = await changeJobPostingStatus(
			scope,
			posting.id,
			'published',
			{
				now: NOW,
			},
		)
		expect(published.ok && published.value.publishedAt).toBe(NOW.toISOString())

		expect(await deleteJobPosting(scope, posting.id, NOW)).toEqual({
			ok: false,
			error: 'not_deletable',
		})
		expect(
			await changeJobPostingStatus(scope, posting.id, 'published', {
				now: NOW,
			}),
		).toEqual({ ok: false, error: 'invalid_transition' })

		const closed = await changeJobPostingStatus(scope, posting.id, 'closed', {
			now: NOW,
		})
		expect(closed.ok && closed.value.status).toBe('closed')
		const reopened = await changeJobPostingStatus(
			scope,
			posting.id,
			'published',
			{
				now: NOW,
			},
		)
		expect(reopened.ok && reopened.value.status).toBe('published')
		await changeJobPostingStatus(scope, posting.id, 'closed', { now: NOW })

		expect(await deleteJobPosting(scope, posting.id, NOW)).toEqual({
			ok: true,
			value: { id: posting.id },
		})
		expect(await getJobPosting(scope, posting.id)).toBeNull()
	})

	it('never closes a draft', async () => {
		const posting = await create()
		expect(await changeJobPostingStatus(scope, posting.id, 'closed')).toEqual({
			ok: false,
			error: 'invalid_transition',
		})
	})

	it('will not publish an incomplete draft', async () => {
		const posting = await create({ descriptionHtml: '' })
		expect(
			await changeJobPostingStatus(scope, posting.id, 'published'),
		).toMatchObject({
			ok: false,
			error: 'cannot_publish',
			reasons: ['description'],
		})
	})

	it('needs a new closing date to reopen an ended posting', async () => {
		const posting = await create({ closesOn: '2026-10-20' })
		await changeJobPostingStatus(scope, posting.id, 'published', {
			now: new Date('2026-10-13T00:00:00Z'),
		})
		const later = new Date('2026-11-01T00:00:00Z')
		const stale = await getJobPosting(scope, posting.id, later)
		expect(stale?.status).toBe('expired')

		expect(
			await changeJobPostingStatus(scope, posting.id, 'published', {
				now: later,
			}),
		).toMatchObject({
			ok: false,
			error: 'cannot_publish',
			reasons: ['closes_on_past'],
		})

		const reopened = await changeJobPostingStatus(
			scope,
			posting.id,
			'published',
			{
				now: later,
				closesOn: '2026-12-01',
			},
		)
		expect(reopened.ok && reopened.value.status).toBe('published')
		expect(reopened.ok && reopened.value.closesOn).toBe('2026-12-01')
	})
})

describe('expireJobPostings', () => {
	it('expires only live postings that have ended, and is idempotent', async () => {
		const ended = await create({ closesOn: '2026-10-14' })
		const open = await create({ title: 'Barista', closesOn: '2026-12-01' })
		const noEnd = await create({ title: 'Host' })
		const draft = await create({ title: 'Dishwasher', closesOn: '2026-10-14' })
		for (const posting of [ended, open, noEnd]) {
			await changeJobPostingStatus(scope, posting.id, 'published', { now: NOW })
		}
		const after = new Date('2026-10-20T00:00:00Z')
		// Other test files share this database; only assert on this organization.
		await expireJobPostings(after)
		expect(await expireJobPostings(after)).toEqual({ expired: 0 })
		const rows = await db
			.select()
			.from(JobPosting)
			.where(eq(JobPosting.organizationId, organizationId))
		const byId = Object.fromEntries(rows.map((row) => [row.id, row.status]))
		expect(byId[ended.id]).toBe('expired')
		expect(byId[open.id]).toBe('published')
		expect(byId[noEnd.id]).toBe('published')
		expect(byId[draft.id]).toBe('draft')
	})
})

describe('public postings', () => {
	it('serves only live postings, without dealbreakers', async () => {
		const posting = await create({
			payType: 'hourly',
			payMinMinor: 1800,
			payMaxMinor: 2200,
			questions: [
				{
					id: 'weekends',
					kind: 'yes_no',
					prompt: 'Can you work weekends?',
					category: 'availability',
					dealbreaker: true,
					requiredAnswer: 'yes',
				},
			],
		})
		const hidden = await create({ title: 'Draft only' })
		expect(hidden.status).toBe('draft')
		expect(await listPublicJobPostings(organizationId, NOW)).toEqual([])
		expect(
			await getPublicJobPosting(organizationId, posting.slug, NOW),
		).toBeNull()

		await changeJobPostingStatus(scope, posting.id, 'published', { now: NOW })
		const list = await listPublicJobPostings(organizationId, NOW)
		expect(list.map((item) => item.slug)).toEqual([posting.slug])
		expect(list[0]).not.toHaveProperty('descriptionHtml')
		expect(list[0]).not.toHaveProperty('locations')

		const detail = await getPublicJobPosting(organizationId, posting.slug, NOW)
		expect(detail?.questions).toEqual([
			{
				id: 'weekends',
				kind: 'yes_no',
				prompt: 'Can you work weekends?',
				category: 'availability',
			},
		])
		expect(JSON.stringify(detail)).not.toMatch(
			/dealbreaker|requiredAnswer|createdByUserId|organizationId/,
		)
	})

	it('does not serve another organization’s slug', async () => {
		const posting = await create()
		await changeJobPostingStatus(scope, posting.id, 'published', { now: NOW })
		const otherOrg = await makeOrg()
		expect(await getPublicJobPosting(otherOrg, posting.slug, NOW)).toBeNull()
		expect(await listPublicJobPostings(otherOrg, NOW)).toEqual([])
	})

	it('stops serving a posting the moment it ends, before the job runs', async () => {
		const posting = await create({ closesOn: '2026-10-14' })
		await changeJobPostingStatus(scope, posting.id, 'published', { now: NOW })
		const later = new Date('2026-10-15T00:00:00Z')
		expect(
			await getPublicJobPosting(organizationId, posting.slug, later),
		).toBeNull()
		expect(await listPublicJobPostings(organizationId, later)).toEqual([])
	})

	it('re-sanitizes a description that was edited out of band', async () => {
		const posting = await create()
		await changeJobPostingStatus(scope, posting.id, 'published', { now: NOW })
		await db
			.update(JobPosting)
			.set({
				descriptionHtml:
					'<p>Fine</p><img src=x onerror=alert(1)><script>alert(1)</script>',
			})
			.where(eq(JobPosting.id, posting.id))
		const detail = await getPublicJobPosting(organizationId, posting.slug, NOW)
		expect(detail?.descriptionHtml).toBe('<p>Fine</p>')
	})

	it('survives corrupt stored questions', async () => {
		const posting = await create()
		await changeJobPostingStatus(scope, posting.id, 'published', { now: NOW })
		await db
			.update(JobPosting)
			.set({ questions: 'not an array' as never })
			.where(eq(JobPosting.id, posting.id))
		const detail = await getPublicJobPosting(organizationId, posting.slug, NOW)
		expect(detail?.questions).toEqual([])
	})

	describe('translations', () => {
		const question = {
			id: 'weekends',
			kind: 'yes_no',
			prompt: 'Can you work weekends?',
			category: 'availability',
			dealbreaker: false,
			requiredAnswer: 'yes',
		}

		it('keeps cleaned other-language copy and drops what is empty or unknown', async () => {
			const posting = await create({
				questions: [question],
				translations: {
					ar: {
						title: '<b>طباخ</b>',
						descriptionHtml: '<p>اطبخ معنا</p><script>alert(1)</script>',
						prompts: { weekends: 'هل تعمل في العطلات؟', ghost: 'ignored' },
					},
					fr: { title: '   ' },
				},
			})
			expect(posting.translations).toEqual({
				ar: {
					title: 'طباخ',
					descriptionHtml: '<p>اطبخ معنا</p>',
					prompts: { weekends: 'هل تعمل في العطلات؟' },
				},
			})
		})

		it('serves the visitor’s language and falls back to the default', async () => {
			const posting = await create({
				questions: [question, { ...question, id: 'extra', prompt: 'Extra?' }],
				translations: {
					ar: {
						title: 'طباخ',
						descriptionHtml: '<p>اطبخ معنا</p>',
						prompts: { weekends: 'هل تعمل في العطلات؟' },
					},
				},
			})
			await changeJobPostingStatus(scope, posting.id, 'published', {
				now: NOW,
			})

			const arabic = await getPublicJobPosting(
				organizationId,
				posting.slug,
				NOW,
				{ locale: 'ar-SA', defaultLocale: 'en' },
			)
			expect(arabic?.title).toBe('طباخ')
			expect(arabic?.descriptionHtml).toContain('اطبخ معنا')
			expect(arabic?.questions.map((q) => q.prompt)).toEqual([
				'هل تعمل في العطلات؟',
				// Not translated yet: the default copy, never blank.
				'Extra?',
			])

			const english = await getPublicJobPosting(
				organizationId,
				posting.slug,
				NOW,
				{ locale: 'en', defaultLocale: 'en' },
			)
			expect(english?.title).toBe('Line cook')

			const list = await listPublicJobPostings(organizationId, NOW, {
				locale: 'ar',
				defaultLocale: 'en',
			})
			expect(list[0]?.title).toBe('طباخ')
		})

		it('keeps a posting readable in a language it has no translation for', async () => {
			const posting = await create({ translations: { ar: { title: 'طباخ' } } })
			await changeJobPostingStatus(scope, posting.id, 'published', {
				now: NOW,
			})
			const detail = await getPublicJobPosting(
				organizationId,
				posting.slug,
				NOW,
				{ locale: 'fr', defaultLocale: 'en' },
			)
			expect(detail?.title).toBe('Line cook')
		})
	})

	it('lets the intake accept the one implicit scope', async () => {
		const posting = await create({})
		await changeJobPostingStatus(scope, posting.id, 'published', { now: NOW })
		const intake = await getIntakePosting(organizationId, posting.slug, NOW)
		expect(intake?.scopeIds).toEqual([DEFAULT_SCOPE_ID])
	})
})
