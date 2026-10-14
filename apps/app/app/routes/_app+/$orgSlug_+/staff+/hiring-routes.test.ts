import {
	ConfigFlag,
	db,
	inArray,
	JobPosting,
	OrganizationRole,
	_OrganizationPermissionToRole,
} from '@repo/database'
import { STAFFING_FLAG_KEYS, type StaffingFeature } from '@repo/staffing'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

const ai = vi.hoisted(() => ({ generateContent: vi.fn() }))
vi.mock('@repo/ai/server', () => ({ generateContent: ai.generateContent }))

import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	action as editAction,
	loader as editLoader,
} from './hiring.$postingId.tsx'
import {
	loader as indexLoader,
	action as indexAction,
} from './hiring._index.tsx'
import { action as newAction, loader as newLoader } from './hiring.new.tsx'

const flagIds: string[] = []

async function enableHiring(organizationId: string) {
	for (const feature of ['enabled', 'hiring'] as StaffingFeature[]) {
		const [row] = await db
			.insert(ConfigFlag)
			.values({
				key: STAFFING_FLAG_KEYS[feature],
				value: true,
				level: 'organization',
				organizationId,
			})
			.returning({ id: ConfigFlag.id })
		flagIds.push(row!.id)
	}
}

afterEach(async () => {
	ai.generateContent.mockReset()
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

const url = (slug: string, path = '') =>
	`http://localhost:3000/${slug}/staff/hiring${path}`

function formRequest(
	slug: string,
	cookie: string,
	fields: Record<string, string>,
	path = '',
) {
	const body = new FormData()
	for (const [key, value] of Object.entries(fields)) body.set(key, value)
	return createAuthenticatedRequest(
		url(slug, path),
		{ method: 'POST', body },
		cookie,
	)
}

async function outcome(work: () => Promise<unknown>) {
	try {
		const result = (await work()) as {
			data?: unknown
			init?: { status?: number } | null
		} | null
		return {
			status: result?.init?.status ?? 200,
			data: (result && 'data' in result ? result.data : result) as any,
		}
	} catch (error) {
		if (error instanceof Response) {
			return {
				status: error.status,
				location: error.headers.get('Location'),
				data: null as any,
			}
		}
		throw error
	}
}

const content = {
	title: 'Line cook',
	positionName: 'Cook',
	employmentType: 'full_time',
	descriptionHtml: '<p>Cook on the line during busy dinner service.</p>',
}
const payload = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({ ...content, ...extra })

async function readOnlyMember(organizationId: string) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Reader ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	await db
		.insert(_OrganizationPermissionToRole)
		.values({ A: role!.id, B: 'org_perm_read_hiring_any' })
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, role!.id)
	const { cookie } = await createTestSession(user.id)
	return cookie
}

describe('hiring routes while staffing.hiring is off', () => {
	it('answers 404 to an admin on every loader and action', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const slug = organization.slug
		const params = { orgSlug: slug, postingId: 'x' }
		const get = (path = '') =>
			createAuthenticatedRequest(url(slug, path), {}, cookie)
		for (const work of [
			() => indexLoader({ request: get(), params } as any),
			() => newLoader({ request: get('/new'), params } as any),
			() => editLoader({ request: get('/x'), params } as any),
			() =>
				indexAction({
					request: formRequest(slug, cookie, { intent: 'add_general' }),
					params,
				} as any),
			() =>
				newAction({
					request: formRequest(
						slug,
						cookie,
						{ intent: 'save', payload: payload() },
						'/new',
					),
					params,
				} as any),
			() =>
				editAction({
					request: formRequest(slug, cookie, { intent: 'delete' }, '/x'),
					params,
				} as any),
		]) {
			expect((await outcome(work)).status).toBe(404)
		}
		expect(
			await db
				.select()
				.from(JobPosting)
				.where(inArray(JobPosting.organizationId, [organization.id])),
		).toHaveLength(0)
	})

	it('answers 404 when only the master flag is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const [row] = await db
			.insert(ConfigFlag)
			.values({
				key: STAFFING_FLAG_KEYS.enabled,
				value: true,
				level: 'organization',
				organizationId: organization.id,
			})
			.returning({ id: ConfigFlag.id })
		flagIds.push(row!.id)
		const result = await outcome(() =>
			indexLoader({
				request: createAuthenticatedRequest(url(organization.slug), {}, cookie),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect(result.status).toBe(404)
	})
})

describe('hiring routes with the flag on', () => {
	it('refuses a built-in member (no hiring permission)', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('member')
		await enableHiring(organization.id)
		const result = await outcome(() =>
			indexLoader({
				request: createAuthenticatedRequest(url(organization.slug), {}, cookie),
				params: { orgSlug: organization.slug },
			} as any),
		)
		expect(result.status).toBe(403)
	})

	it('creates, lists, edits, publishes, closes and deletes a job', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableHiring(organization.id)
		const slug = organization.slug

		const created = await outcome(() =>
			newAction({
				request: formRequest(
					slug,
					cookie,
					{ intent: 'save', step: 'pay', payload: payload() },
					'/new',
				),
				params: { orgSlug: slug },
			} as any),
		)
		expect(created.status).toBe(302)
		const [, id, query] =
			/\/hiring\/([^?]+)\?(.*)$/.exec(created.location ?? '') ?? []
		expect(id).toBeTruthy()
		expect(query).toBe('step=pay')

		const list = await outcome(() =>
			indexLoader({
				request: createAuthenticatedRequest(url(slug), {}, cookie),
				params: { orgSlug: slug },
			} as any),
		)
		const listed = list.data as any
		expect(listed.postings.map((p: any) => p.id)).toEqual([id])
		expect(listed.canWrite).toBe(true)
		expect(listed.canOfferGeneral).toBe(true)

		const params = { orgSlug: slug, postingId: id }
		const detail = await outcome(() =>
			editLoader({
				request: createAuthenticatedRequest(
					url(slug, `/${id}?step=review`),
					{},
					cookie,
				),
				params,
			} as any),
		)
		expect((detail.data as any).initialStep).toBe('review')
		expect((detail.data as any).posting.status).toBe('draft')

		const saved = await outcome(() =>
			editAction({
				request: formRequest(
					slug,
					cookie,
					{ intent: 'save', payload: payload({ title: 'Head chef' }) },
					`/${id}`,
				),
				params,
			} as any),
		)
		expect(saved.data).toMatchObject({ ok: true, intent: 'save' })

		const published = await outcome(() =>
			editAction({
				request: formRequest(
					slug,
					cookie,
					{ intent: 'publish', payload: payload({ title: 'Head chef' }) },
					`/${id}`,
				),
				params,
			} as any),
		)
		expect(published.data.posting.status).toBe('published')

		// A live job cannot be deleted, a draft-only intent cannot be replayed.
		expect(
			(
				await outcome(() =>
					editAction({
						request: formRequest(slug, cookie, { intent: 'delete' }, `/${id}`),
						params,
					} as any),
				)
			).status,
		).toBe(409)

		const closed = await outcome(() =>
			editAction({
				request: formRequest(slug, cookie, { intent: 'close' }, `/${id}`),
				params,
			} as any),
		)
		expect(closed.data.posting.status).toBe('closed')

		const deleted = await outcome(() =>
			editAction({
				request: formRequest(slug, cookie, { intent: 'delete' }, `/${id}`),
				params,
			} as any),
		)
		expect(deleted).toMatchObject({
			status: 302,
			location: `/${slug}/staff/hiring`,
		})
	})

	it('offers a general application once, as a draft', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableHiring(organization.id)
		const slug = organization.slug
		const first = await outcome(() =>
			indexAction({
				request: formRequest(slug, cookie, {
					intent: 'add_general',
					currency: 'SAR',
				}),
				params: { orgSlug: slug },
			} as any),
		)
		expect(first.status).toBe(302)
		expect(first.location).toMatch(/\/hiring\/.+\?step=review$/)
		const second = await outcome(() =>
			indexAction({
				request: formRequest(slug, cookie, { intent: 'add_general' }),
				params: { orgSlug: slug },
			} as any),
		)
		expect(second.status).toBe(409)
		const rows = await db
			.select()
			.from(JobPosting)
			.where(inArray(JobPosting.organizationId, [organization.id]))
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			isGeneral: true,
			status: 'draft',
			slug: 'general-application',
			currency: 'SAR',
		})
	})

	it('rejects malformed requests without touching the database', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableHiring(organization.id)
		const slug = organization.slug
		const call = (fields: Record<string, string>) =>
			outcome(() =>
				newAction({
					request: formRequest(slug, cookie, fields, '/new'),
					params: { orgSlug: slug },
				} as any),
			)
		expect((await call({ intent: 'nuke' })).status).toBe(400)
		expect((await call({ intent: 'save' })).status).toBe(400)
		expect((await call({ intent: 'save', payload: '{not json' })).status).toBe(
			400,
		)
		expect(
			(await call({ intent: 'save', payload: 'x'.repeat(130_000) })).status,
		).toBe(400)
		const invalid = await call({
			intent: 'save',
			payload: payload({ title: 'x', payType: 'hourly' }),
		})
		expect(invalid.status).toBe(400)
		expect(invalid.data).toMatchObject({ ok: false, error: 'invalid_input' })
		// Delete and close need a posting; on /new there is none.
		expect((await call({ intent: 'delete' })).status).toBe(400)
		expect((await call({ intent: 'close' })).status).toBe(400)
		expect(
			await db
				.select()
				.from(JobPosting)
				.where(inArray(JobPosting.organizationId, [organization.id])),
		).toHaveLength(0)
	})

	it('does not let another organization’s admin see or change a job', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		await enableHiring(a.organization.id)
		await enableHiring(b.organization.id)
		const created = await outcome(() =>
			newAction({
				request: formRequest(
					a.organization.slug,
					a.cookie,
					{ intent: 'save', payload: payload() },
					'/new',
				),
				params: { orgSlug: a.organization.slug },
			} as any),
		)
		const id = /\/hiring\/([^?]+)/.exec(created.location ?? '')![1]!

		// B's own screens, with A's posting id: it does not exist there.
		const params = { orgSlug: b.organization.slug, postingId: id }
		expect(
			(
				await outcome(() =>
					editLoader({
						request: createAuthenticatedRequest(
							url(b.organization.slug, `/${id}`),
							{},
							b.cookie,
						),
						params,
					} as any),
				)
			).status,
		).toBe(404)
		for (const intent of ['delete', 'close']) {
			expect(
				(
					await outcome(() =>
						editAction({
							request: formRequest(
								b.organization.slug,
								b.cookie,
								{ intent },
								`/${id}`,
							),
							params,
						} as any),
					)
				).status,
			).toBe(404)
		}
		// B's admin cannot reach A's organization at all.
		expect(
			(
				await outcome(() =>
					indexLoader({
						request: createAuthenticatedRequest(
							url(a.organization.slug),
							{},
							b.cookie,
						),
						params: { orgSlug: a.organization.slug },
					} as any),
				)
			).status,
		).toBe(404)
		const [row] = await db
			.select()
			.from(JobPosting)
			.where(inArray(JobPosting.id, [id]))
		expect(row?.status).toBe('draft')
	})

	it('lets a read-only role look at jobs but never change them', async () => {
		const admin = await setupTestOrgWithUser('admin')
		await enableHiring(admin.organization.id)
		const slug = admin.organization.slug
		const created = await outcome(() =>
			newAction({
				request: formRequest(
					slug,
					admin.cookie,
					{ intent: 'save', payload: payload() },
					'/new',
				),
				params: { orgSlug: slug },
			} as any),
		)
		const id = /\/hiring\/([^?]+)/.exec(created.location ?? '')![1]!
		const cookie = await readOnlyMember(admin.organization.id)

		const list = await outcome(() =>
			indexLoader({
				request: createAuthenticatedRequest(url(slug), {}, cookie),
				params: { orgSlug: slug },
			} as any),
		)
		expect((list.data as any).canWrite).toBe(false)
		expect((list.data as any).postings).toHaveLength(1)
		const params = { orgSlug: slug, postingId: id }
		const detail = await outcome(() =>
			editLoader({
				request: createAuthenticatedRequest(url(slug, `/${id}`), {}, cookie),
				params,
			} as any),
		)
		expect((detail.data as any).canWrite).toBe(false)

		expect(
			(
				await outcome(() =>
					newLoader({
						request: createAuthenticatedRequest(url(slug, '/new'), {}, cookie),
						params,
					} as any),
				)
			).status,
		).toBe(403)
		for (const intent of ['save', 'publish', 'close', 'delete', 'ai_draft']) {
			expect(
				(
					await outcome(() =>
						editAction({
							request: formRequest(
								slug,
								cookie,
								{ intent, payload: payload(), prompt: 'cook' },
								`/${id}`,
							),
							params,
						} as any),
					)
				).status,
			).toBe(403)
		}
		expect(ai.generateContent).not.toHaveBeenCalled()
	})

	it('drafts with the model and returns it without saving anything', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableHiring(organization.id)
		ai.generateContent.mockResolvedValue(
			JSON.stringify({
				title: 'Evening line cook',
				positionName: 'Line cook',
				employmentType: 'part_time',
				descriptionHtml: '<p>Cook with us three nights a week.</p>',
				questions: [],
			}),
		)
		const slug = organization.slug
		const result = await outcome(() =>
			newAction({
				request: formRequest(
					slug,
					cookie,
					{ intent: 'ai_draft', prompt: 'evening cook' },
					'/new',
				),
				params: { orgSlug: slug },
			} as any),
		)
		expect(result.data).toMatchObject({
			ok: true,
			intent: 'ai_draft',
			draft: { title: 'Evening line cook' },
		})
		const sent = ai.generateContent.mock.calls[0]![0].prompt as string
		expect(sent).toContain('evening cook')
		expect(
			await db
				.select()
				.from(JobPosting)
				.where(inArray(JobPosting.organizationId, [organization.id])),
		).toHaveLength(0)

		const tooLong = await outcome(() =>
			newAction({
				request: formRequest(
					slug,
					cookie,
					{ intent: 'ai_draft', prompt: 'x'.repeat(5_000) },
					'/new',
				),
				params: { orgSlug: slug },
			} as any),
		)
		expect(tooLong.status).toBe(400)
		expect(ai.generateContent).toHaveBeenCalledTimes(1)

		ai.generateContent.mockRejectedValue(new Error('down'))
		const down = await outcome(() =>
			newAction({
				request: formRequest(
					slug,
					cookie,
					{ intent: 'ai_draft', prompt: 'cook' },
					'/new',
				),
				params: { orgSlug: slug },
			} as any),
		)
		expect(down.data).toMatchObject({ ok: false, error: 'draft_failed' })
	})
})
