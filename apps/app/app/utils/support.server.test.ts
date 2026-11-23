import {
	SUPPORT_CONTEXT_KEYS,
	parseStoredSupportContext,
} from '@repo/common/support-requests'
import {
	Feedback,
	FeedbackMessage,
	OrganizationAssignment,
	OrganizationLocation,
	db,
	eq,
} from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	action as listAction,
	loader as listLoader,
} from '#app/routes/_app+/$orgSlug_+/support.tsx'
import { action as createAction } from '#app/routes/resources+/support.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'
import {
	countUnreadSupportRequests,
	loadSupportContact,
} from './support.server.ts'

async function submit(
	cookie: string,
	fields: Record<string, string>,
): Promise<Response> {
	const body = new FormData()
	for (const [key, value] of Object.entries(fields)) body.set(key, value)
	const request = createAuthenticatedRequest(
		'http://localhost:3000/resources/support',
		{ method: 'POST', body },
		cookie,
	)
	try {
		return (await createAction({ request } as never)) as Response
	} catch (thrown) {
		return thrown as Response
	}
}

async function load(cookie: string, slug: string, search = '') {
	const request = createAuthenticatedRequest(
		`http://localhost:3000/${slug}/support${search}`,
		{},
		cookie,
	)
	try {
		return (await listLoader({
			request,
			params: { orgSlug: slug },
		} as never)) as {
			requests: Array<{ id: string; status: string; unread: boolean }>
			thread: { id: string; unread: boolean; status: string } | null
		}
	} catch (thrown) {
		return thrown as Response
	}
}

async function act(
	cookie: string,
	slug: string,
	fields: Record<string, string>,
): Promise<unknown> {
	const body = new FormData()
	for (const [key, value] of Object.entries(fields)) body.set(key, value)
	const request = createAuthenticatedRequest(
		`http://localhost:3000/${slug}/support`,
		{ method: 'POST', body },
		cookie,
	)
	try {
		return await listAction({ request, params: { orgSlug: slug } } as never)
	} catch (thrown) {
		return thrown
	}
}

/** What Admin's reply does to the record (the Admin test covers its own code). */
async function supportReplies(requestId: string, body = 'We looked into it') {
	const now = new Date()
	await db.insert(FeedbackMessage).values({
		feedbackId: requestId,
		side: 'support',
		body,
		createdAt: now,
	})
	await db
		.update(Feedback)
		.set({
			status: 'waiting_on_you',
			lastMessageAt: now,
			lastMessageSide: 'support',
			supportReadAt: now,
		})
		.where(eq(Feedback.id, requestId))
}

async function restaurant() {
	const owner = await createTestUser()
	const organization = await createTestOrganization(owner.id, 'admin')
	const { cookie } = await createTestSession(owner.id)
	return { owner, organization, cookie }
}

beforeEach(() => {
	vi.restoreAllMocks()
})
afterEach(() => vi.unstubAllGlobals())

describe('Contact support (#233)', () => {
	it('arrives with the restaurant, location, page, version and error id, and nothing about a guest', async () => {
		const { organization, cookie } = await restaurant()
		const [location] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: organization.id,
				name: 'Main street',
				slug: 'main-street',
			})
			.returning()

		const response = await submit(cookie, {
			organizationSlug: organization.slug,
			kind: 'problem',
			message: 'The order page shows an error',
			// A search box can hold a guest's name: only the path may travel.
			path: `/${organization.slug}/orders?search=Jane%20Doe&phone=%2B15551234567#token=abc`,
			errorId: 'a1b2c3d4e5f6a7b8',
			locationId: location!.id,
		})
		expect(response.status).toBe(200)
		const { id } = (await response.json()) as { id: string }

		const [row] = await db.select().from(Feedback).where(eq(Feedback.id, id))
		expect(row!.kind).toBe('problem')
		expect(row!.status).toBe('open')
		expect(row!.errorId).toBe('a1b2c3d4e5f6a7b8')
		const context = parseStoredSupportContext(row!.context)
		expect(context).toMatchObject({
			organizationId: organization.id,
			organizationSlug: organization.slug,
			locationId: location!.id,
			path: `/${organization.slug}/orders`,
			errorId: 'a1b2c3d4e5f6a7b8',
		})
		expect(context.appVersion).toBeTruthy()
		// Only allowlisted keys are stored, and no guest value is in the record.
		expect(
			Object.keys(JSON.parse(row!.context!) as object).every((key) =>
				(SUPPORT_CONTEXT_KEYS as readonly string[]).includes(key),
			),
		).toBe(true)
		expect(JSON.stringify(row)).not.toMatch(/Jane|5551234567|token=abc/)
	})

	it("ignores a location that is not the restaurant's and refuses a field outside the form", async () => {
		const { organization, cookie } = await restaurant()
		const other = await restaurant()
		const [foreign] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: other.organization.id,
				name: 'Elsewhere',
				slug: 'elsewhere',
			})
			.returning()
		const ok = await submit(cookie, {
			organizationSlug: organization.slug,
			kind: 'support',
			message: 'Hello',
			locationId: foreign!.id,
		})
		const { id } = (await ok.json()) as { id: string }
		const [row] = await db.select().from(Feedback).where(eq(Feedback.id, id))
		expect(parseStoredSupportContext(row!.context).locationId).toBeUndefined()

		const refused = await submit(cookie, {
			organizationSlug: organization.slug,
			kind: 'support',
			message: 'Hello',
			guestName: 'Jane Doe',
		})
		expect(refused.status).toBe(400)
		expect(JSON.stringify(await refused.json())).not.toContain('Jane')
	})

	it('is rate limited per member', async () => {
		const { organization, cookie } = await restaurant()
		const fields = {
			organizationSlug: organization.slug,
			kind: 'support',
			message: 'Hello',
		}
		for (let sent = 0; sent < 5; sent++) {
			expect((await submit(cookie, fields)).status).toBe(200)
		}
		expect((await submit(cookie, fields)).status).toBe(429)
	})

	it('works without the regional node: it never calls a regional service', async () => {
		const { organization, cookie } = await restaurant()
		const fetchSpy = vi.fn(async () => {
			throw new Error('regional node is down')
		})
		vi.stubGlobal('fetch', fetchSpy)
		const response = await submit(cookie, {
			organizationSlug: organization.slug,
			kind: 'support',
			message: 'Hello',
		})
		expect(response.status).toBe(200)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('refuses a member of another restaurant', async () => {
		const { organization } = await restaurant()
		const stranger = await createTestUser()
		const { cookie } = await createTestSession(stranger.id)
		const response = await submit(cookie, {
			organizationSlug: organization.slug,
			kind: 'support',
			message: 'Hello',
		})
		expect(response.status).toBe(404)
	})

	it('routes the request to the support contact first and shows its first name only', async () => {
		const { organization, cookie } = await restaurant()
		const manager = await createTestUser({
			name: 'Marta Manager',
			role: 'admin',
		})
		const sara = await createTestUser({
			name: 'Sara Support',
			email: 'sara.private@menuza.test',
			role: 'admin',
		})
		await db.insert(OrganizationAssignment).values([
			{
				organizationId: organization.id,
				adminUserId: manager.id,
				role: 'account_manager',
				scopeKey: 'all',
			},
			{
				organizationId: organization.id,
				adminUserId: sara.id,
				role: 'support',
				scopeKey: 'all',
			},
		])
		const response = await submit(cookie, {
			organizationSlug: organization.slug,
			kind: 'support',
			message: 'Hello',
		})
		const { id } = (await response.json()) as { id: string }
		const [row] = await db.select().from(Feedback).where(eq(Feedback.id, id))
		expect(row!.assigneeId).toBe(sara.id)

		const contact = await loadSupportContact(organization.id)
		expect(contact).toEqual({ firstName: 'Sara', imageObjectKey: null })
		expect(JSON.stringify(contact)).not.toMatch(
			/Support|private|menuza\.test|@/,
		)
	})
})

describe('Support page (#406)', () => {
	it('lists a request sent from Help, shows an unread badge for a reply, and reading clears it', async () => {
		const { owner, organization, cookie } = await restaurant()
		const sent = await submit(cookie, {
			organizationSlug: organization.slug,
			kind: 'support',
			message: 'How do I pause ordering?',
			subject: 'Pausing',
		})
		const { id } = (await sent.json()) as { id: string }

		let page = (await load(cookie, organization.slug)) as Awaited<
			ReturnType<typeof load>
		> & { requests: Array<{ id: string; status: string; unread: boolean }> }
		expect(page.requests.map((r) => r.id)).toContain(id)
		expect(page.requests.find((r) => r.id === id)).toMatchObject({
			status: 'open',
			unread: false,
		})
		expect(await countUnreadSupportRequests(owner.id)).toBe(0)

		await supportReplies(id)
		page = (await load(cookie, organization.slug)) as typeof page
		expect(page.requests.find((r) => r.id === id)).toMatchObject({
			status: 'waiting_on_you',
			unread: true,
		})
		expect(await countUnreadSupportRequests(owner.id)).toBe(1)

		// Opening the thread shows it as unread once; the read action clears it.
		const opened = (await load(
			cookie,
			organization.slug,
			`?request=${id}`,
		)) as unknown as {
			thread: {
				unread: boolean
				messages: Array<{ side: string; body: string }>
			}
		}
		expect(opened.thread.unread).toBe(true)
		expect(opened.thread.messages.map((m) => m.side)).toEqual([
			'member',
			'support',
		])
		await act(cookie, organization.slug, { intent: 'read', requestId: id })
		expect(await countUnreadSupportRequests(owner.id)).toBe(0)
		const again = (await load(cookie, organization.slug, `?request=${id}`)) as {
			thread: { unread: boolean }
		}
		expect(again.thread.unread).toBe(false)
	})

	it('moves a request to closed when it is closed, and a reply opens it again', async () => {
		const { organization, cookie } = await restaurant()
		const sent = await submit(cookie, {
			organizationSlug: organization.slug,
			kind: 'support',
			message: 'Question',
		})
		const { id } = (await sent.json()) as { id: string }
		await act(cookie, organization.slug, { intent: 'close', requestId: id })
		let page = (await load(cookie, organization.slug)) as {
			requests: Array<{ id: string; status: string }>
		}
		expect(page.requests.find((r) => r.id === id)?.status).toBe('closed')

		await act(cookie, organization.slug, {
			intent: 'reply',
			requestId: id,
			message: 'One more thing',
		})
		page = (await load(cookie, organization.slug)) as typeof page
		expect(page.requests.find((r) => r.id === id)?.status).toBe('open')
	})

	it('shows another restaurant nothing, and a plain member only their own requests', async () => {
		const { organization, cookie } = await restaurant()
		const sent = await submit(cookie, {
			organizationSlug: organization.slug,
			kind: 'support',
			message: 'Private question',
		})
		const { id } = (await sent.json()) as { id: string }

		// Another restaurant's owner: not a member here, so the page is a 404.
		const other = await restaurant()
		const foreign = (await load(other.cookie, organization.slug)) as Response
		expect(foreign.status).toBe(404)
		const stolen = (await load(
			other.cookie,
			other.organization.slug,
			`?request=${id}`,
		)) as { requests: unknown[]; thread: unknown }
		expect(stolen.requests).toHaveLength(0)
		expect(stolen.thread).toBeNull()
		expect(
			(await act(other.cookie, other.organization.slug, {
				intent: 'close',
				requestId: id,
			})) as Response,
		).toMatchObject({ init: { status: 404 } })

		// A plain member of the same restaurant has no support permission: they see
		// their own requests only.
		const member = await createTestUser()
		await addOrganizationMember(member.id, organization.id, 'org_role_member')
		const { cookie: memberCookie } = await createTestSession(member.id)
		const own = (await load(memberCookie, organization.slug)) as {
			requests: unknown[]
			thread: unknown
		}
		expect(own.requests).toHaveLength(0)
		const seeThread = (await load(
			memberCookie,
			organization.slug,
			`?request=${id}`,
		)) as { thread: unknown }
		expect(seeThread.thread).toBeNull()
	})
})
