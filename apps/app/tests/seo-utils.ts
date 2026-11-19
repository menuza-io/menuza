import { ConfigFlag, db, eq, Organization } from '@repo/database'
import { insertTestUser } from './dashboard-utils.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
} from './test-utils.ts'

/** A published site with a signed-in member of the given role (#88, #137, #138, #182, #184 tests). */
export async function setupSeoOrganization(
	role: 'admin' | 'member' | 'viewer' = 'admin',
	overrides: Partial<typeof Organization.$inferInsert> = {},
) {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, role)
	await db
		.update(Organization)
		.set({ sitePublished: true, ...overrides })
		.where(eq(Organization.id, organization.id))
	const { cookie } = await createTestSession(user.id)
	return { organization, cookie, userId: user.id }
}

export async function setOrgFlag(
	organizationId: string,
	key: string,
	value: unknown,
) {
	await db.insert(ConfigFlag).values({
		key,
		value: value as never,
		level: 'organization',
		organizationId,
	})
}

type RouteFn = (args: never) => unknown

/** `data()` results (React Router) as a Response, so tests read one shape. */
function asResponse(value: unknown): Response {
	if (value instanceof Response) return value
	const result = value as {
		type?: string
		data?: unknown
		init?: ResponseInit | null
	}
	if (result?.type === 'DataWithResponseInit') {
		return Response.json(result.data, { status: result.init?.status ?? 200 })
	}
	return Response.json(value)
}

/** Calls a route action with an urlencoded body, returning the Response (thrown ones too). */
export async function callAction(
	fn: RouteFn,
	input: {
		url: string
		cookie: string
		params: Record<string, string>
		fields: Record<string, string | string[]>
	},
): Promise<Response> {
	const body = new URLSearchParams()
	for (const [key, value] of Object.entries(input.fields)) {
		for (const item of Array.isArray(value) ? value : [value])
			body.append(key, item)
	}
	try {
		return asResponse(
			await fn({
				request: createAuthenticatedRequest(
					input.url,
					{ method: 'POST', body },
					input.cookie,
				),
				params: input.params,
				context: {},
			} as never),
		)
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

export async function callLoader(
	fn: RouteFn,
	input: { url: string; cookie?: string; params?: Record<string, string> },
): Promise<Response | Record<string, unknown>> {
	try {
		return (await fn({
			request: input.cookie
				? createAuthenticatedRequest(input.url, {}, input.cookie)
				: new Request(input.url),
			params: input.params ?? {},
			context: {},
		} as never)) as Response | Record<string, unknown>
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

/** Reads the public organization payload Sites renders from. */
export async function publicSitePayload(slug: string) {
	const { loader } = await import('#app/routes/resources+/sites.ts')
	const response = (await callLoader(loader as RouteFn, {
		url: `http://localhost/resources/sites?slug=${slug}`,
	})) as Response
	return (await response.json()) as Record<string, any>
}
