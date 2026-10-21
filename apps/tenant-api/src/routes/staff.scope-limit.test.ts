import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	getTenantDb,
	staffAuditLog,
	staffJobs,
	staffScopeAssignments,
	staffMembers,
	staffNotes,
	staffPositions,
	staffPrivate,
	staffingSettings,
} from '@repo/tenant-db'
import {
	ADMIN_GRANTS,
	createStaffHarness,
	LOC_1,
	LOC_2,
	LOC_3,
	makeOrg,
	mintStaffToken,
	ORG_A,
	ORG_B,
	staffBody,
	type StaffHarness,
	type TestOrg,
} from '../../tests/staff-harness.ts'
import { redactChangesForScope } from '../services/staff-service.ts'
import { scopeToScopes } from '../lib/staff-auth.ts'
import { staffOperatorRoutes } from './staff.ts'

/**
 * Per-route cross-scope adversarial suite for `/operator/staff`.
 *
 * A manager whose token is limited to one scope (`scopeIds: [LOC_1]`)
 * attacks every route registered on the router with ids that belong to another
 * scope. Every route must have a case in `CASES` (a guard test fails when a
 * route is added without one), each case asserts the refusal and that nothing
 * leaked, and the whole barrage must leave the data exactly as it found it.
 *
 * Fixture (all in one organization):
 * - A works only at LOC_1; C works only at LOC_2; B works at both;
 *   D has no assignment at all.
 * - Distinct, recognizable pay rates and notes sit at each scope.
 */

const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

type Person = { id: string; assignments: Record<string, string> }

type Fixture = {
	h: StaffHarness
	/** Token limited to LOC_1 with every staff grant. */
	scoped: string
	a: Person
	b: Person
	c: Person
	d: Person
	positions: { p1: string; p2: string; p3: string }
	jobs: { b1: string; b2: string; c: string }
	notes: { a: string; c: string }
	rates: { b1: number; b2: number; c: number }
}

type Call = {
	method: string
	path: string
	body?: unknown
	token?: string
}

const CASES: Record<string, (f: Fixture) => Promise<void>> = {}

function route(key: string, run: (f: Fixture) => Promise<void>) {
	CASES[key] = run
}

async function call(f: Fixture, request: Call) {
	return f.h.request(request.method, request.path, {
		token: request.token ?? f.scoped,
		body: request.body,
	})
}

function expectStatus(
	response: { status: number },
	status: number | number[],
	label: string,
) {
	const accepted = Array.isArray(status) ? status : [status]
	expect(accepted, `${label} -> ${response.status}`).toContain(response.status)
}

/** Nothing the other scope owns may appear anywhere in a response. */
// 10_000_000_000 is the largest rate the API accepts. Its 11 digits only fit a
// 13-digit epoch-ms timestamp as 1710000000000 (March 2024), so the text can
// never appear in a current timestamp, unlike a 4-digit needle.
const HIDDEN_RATE_B2 = 10_000_000_000
const HIDDEN_RATE_C = 10_000_000_000

function expectNoLeak(raw: string, label: string, ...needles: unknown[]) {
	for (const needle of needles) {
		expect(raw, `${label} leaked ${String(needle)}`).not.toContain(
			String(needle),
		)
	}
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

route('GET /', async (f) => {
	const list = await call(f, { method: 'GET', path: '/?limit=200' })
	expect(list.status).toBe(200)
	const names = list.body.staff.map((s: any) => s.firstName).sort()
	expect(names).toEqual(['Alma', 'Basem'])
	expect(list.body.total).toBe(2)
	expectNoLeak(list.raw, 'list', 'Carim', 'Dina', f.c.id, f.d.id, LOC_2)

	// Searching for another scope's person finds nothing, by every field.
	for (const q of [
		'carim',
		'carim@example.com',
		'+14155550102',
		'EMP-C',
		'dina',
		'EMP-D',
	]) {
		const found = await call(f, {
			method: 'GET',
			path: `/?q=${encodeURIComponent(q)}`,
		})
		expect(found.body.staff, `q=${q}`).toEqual([])
		expect(found.body.total, `q=${q}`).toBe(0)
	}

	// Filters cannot be used to reach into another scope.
	const byScope = await call(f, {
		method: 'GET',
		path: `/?scopeId=${LOC_2}`,
	})
	expect(byScope.body.staff).toEqual([])
	expect(byScope.body.total).toBe(0)
	const byOtherScopePosition = await call(f, {
		method: 'GET',
		path: `/?positionId=${f.positions.p3}`,
	})
	expect(byOtherScopePosition.body.staff).toEqual([])
	// Status filters still stay inside the scope.
	for (const status of ['terminated', 'on_leave', 'invited', 'active']) {
		const filtered = await call(f, {
			method: 'GET',
			path: `/?status=${status}`,
		})
		expectNoLeak(filtered.raw, `status=${status}`, f.c.id, f.d.id)
	}

	// A shared person shows only the limited scope's pay, never the other's.
	const withPay = await call(f, { method: 'GET', path: '/?include=pay' })
	const shared = withPay.body.staff.find((s: any) => s.id === f.b.id)
	expect(shared.currentRate.rateMinor).toBe(f.rates.b1)
	expectNoLeak(withPay.raw, 'list pay', f.rates.b2, f.rates.c, LOC_2)

	// Paging past the end does not wrap into other scopes.
	const page = await call(f, { method: 'GET', path: '/?limit=1&offset=2' })
	expect(page.body.staff).toEqual([])
})

route('POST /', async (f) => {
	const before = await rosterCount(f)
	for (const assignments of [
		[{ scopeId: LOC_2 }],
		[{ scopeId: LOC_1 }, { scopeId: LOC_2 }],
		[{ scopeId: LOC_3 }],
		[],
	]) {
		const response = await call(f, {
			method: 'POST',
			path: '/',
			body: staffBody({
				email: `new-${assignments.length}@example.com`,
				phone: undefined,
				employeeNumber: undefined,
				assignments,
			}),
		})
		expectStatus(response, 403, `create at ${JSON.stringify(assignments)}`)
	}
	expect(await rosterCount(f)).toBe(before)
})

route('POST /import', async (f) => {
	const response = await call(f, {
		method: 'POST',
		path: '/import',
		body: {
			members: [
				{
					userId: 'user-x',
					firstName: 'Imp',
					lastName: 'Orter',
					assignments: [{ scopeId: LOC_1 }],
				},
			],
		},
	})
	expectStatus(response, 403, 'import')
	expect(response.body.error).toBe('unrestricted_scope_required')
})

route('POST /bulk', async (f) => {
	const before = await rosterCount(f)
	const response = await call(f, {
		method: 'POST',
		path: '/bulk',
		body: {
			members: [
				{
					firstName: 'Out',
					lastName: 'Side',
					email: 'outside@example.com',
					assignments: [{ scopeId: LOC_2 }],
				},
				{
					firstName: 'No',
					lastName: 'Scope',
					email: 'noscope@example.com',
					assignments: [],
				},
				{
					firstName: 'In',
					lastName: 'Side',
					email: 'inside@example.com',
					assignments: [{ scopeId: LOC_1 }],
				},
			],
		},
	})
	expect(response.status).toBe(200)
	expect(response.body.results.map((r: any) => r.status)).toEqual([
		'invalid',
		'invalid',
		'created',
	])
	expect(await rosterCount(f)).toBe(before + 1)
})

// ---------------------------------------------------------------------------
// Org-wide resources: readable, but only an unrestricted token may change them
// ---------------------------------------------------------------------------

route('GET /positions', async (f) => {
	const response = await call(f, { method: 'GET', path: '/positions' })
	expect(response.status).toBe(200)
})

route('POST /positions', async (f) => {
	const response = await call(f, {
		method: 'POST',
		path: '/positions',
		body: { name: 'Sneaky' },
	})
	expectStatus(response, 403, 'create position')
})

route('PATCH /positions/:positionId', async (f) => {
	const response = await call(f, {
		method: 'PATCH',
		path: `/positions/${f.positions.p3}`,
		body: { name: 'Renamed' },
	})
	expectStatus(response, 403, 'rename position')
})

route('DELETE /positions/:positionId', async (f) => {
	const response = await call(f, {
		method: 'DELETE',
		path: `/positions/${f.positions.p3}`,
	})
	expectStatus(response, 403, 'archive position')
})

route('GET /settings', async (f) => {
	const response = await call(f, { method: 'GET', path: '/settings' })
	expect(response.status).toBe(200)
})

route('PUT /settings', async (f) => {
	const response = await call(f, {
		method: 'PUT',
		path: '/settings',
		body: { pinLength: 6 },
	})
	expectStatus(response, 403, 'settings')
})

route('GET /export', async (f) => {
	// The export is a complete file of what the region holds: org-wide only.
	for (const path of ['/export', `/export?staffId=${f.a.id}`]) {
		const response = await call(f, { method: 'GET', path })
		expectStatus(response, 403, `export ${path}`)
		expectNoLeak(response.raw, path, 'Carim', 'Alma', f.c.id)
	}
})

route('GET /audit', async (f) => {
	const all = await call(f, { method: 'GET', path: '/audit?limit=200' })
	expect(all.status).toBe(200)
	expect(all.body.entries.length).toBeGreaterThan(0)
	for (const entry of all.body.entries) {
		expect(entry.scopeId, entry.action).toBe(LOC_1)
	}
	expectNoLeak(all.raw, 'audit', f.c.id, f.d.id, LOC_2, LOC_3)
	// Asking for the other scope's people by id gets nothing back.
	for (const staffId of [f.c.id, f.d.id]) {
		const forPerson = await call(f, {
			method: 'GET',
			path: `/audit?staffId=${staffId}&limit=200`,
		})
		expect(forPerson.body.entries, staffId).toEqual([])
	}
})

// ---------------------------------------------------------------------------
// One person
// ---------------------------------------------------------------------------

route('GET /:id', async (f) => {
	for (const person of [f.c, f.d]) {
		for (const include of ['', '?include=pay', '?include=pay,private']) {
			const response = await call(f, {
				method: 'GET',
				path: `/${person.id}${include}`,
			})
			expectStatus(response, 404, `GET ${person.id}${include}`)
			expectNoLeak(response.raw, 'person', 'Carim', 'Dina', f.rates.c)
		}
	}
	// A shared person: only the limited scope is visible, and only its pay.
	const shared = await call(f, {
		method: 'GET',
		path: `/${f.b.id}?include=pay,private`,
	})
	expect(shared.status).toBe(200)
	expect(shared.body.assignments.map((x: any) => x.scopeId)).toEqual([LOC_1])
	expect(shared.body.staff.primaryScopeId).toBe(LOC_1)
	expect(shared.body.jobs.map((j: any) => j.scopeId)).toEqual([LOC_1])
	expectNoLeak(shared.raw, 'shared', f.rates.b2, LOC_2, f.b.assignments[LOC_2]!)
})

route('PATCH /:id', async (f) => {
	expectStatus(
		await call(f, {
			method: 'PATCH',
			path: `/${f.c.id}`,
			body: { firstName: 'Hijacked' },
		}),
		404,
		'patch C',
	)
	// B also works at LOC_2, so a LOC_1 manager cannot change the person.
	for (const body of [
		{ firstName: 'Hijacked' },
		{ email: 'hijack@example.com' },
		{ status: 'on_leave' },
		{ primaryScopeId: LOC_2 },
		// Clearing the primary would also unset one held outside the scope.
		{ primaryScopeId: null },
		// Same answer for a scope the person was never assigned to: a 422 here
		// would reveal that they do not work there.
		{ primaryScopeId: 'loc_never_assigned_elsewhere' },
	]) {
		expectStatus(
			await call(f, { method: 'PATCH', path: `/${f.b.id}`, body }),
			403,
			`patch B ${JSON.stringify(body)}`,
		)
	}
})

route('GET /:id/private', async (f) => {
	expectStatus(
		await call(f, { method: 'GET', path: `/${f.c.id}/private` }),
		404,
		'private C',
	)
	const shared = await call(f, { method: 'GET', path: `/${f.b.id}/private` })
	expect(shared.status).toBe(200)
})

route('PUT /:id/private', async (f) => {
	expectStatus(
		await call(f, {
			method: 'PUT',
			path: `/${f.c.id}/private`,
			body: { city: 'Hijackville' },
		}),
		404,
		'private C',
	)
	// B's private details belong to the person, who also works at LOC_2.
	expectStatus(
		await call(f, {
			method: 'PUT',
			path: `/${f.b.id}/private`,
			body: { city: 'Hijackville' },
		}),
		403,
		'private B',
	)
})

route('GET /:id/jobs', async (f) => {
	expectStatus(
		await call(f, { method: 'GET', path: `/${f.c.id}/jobs` }),
		404,
		'jobs C',
	)
	const shared = await call(f, { method: 'GET', path: `/${f.b.id}/jobs` })
	expect(shared.status).toBe(200)
	expect(shared.body.jobs.map((j: any) => j.scopeId)).toEqual([LOC_1])
	expectNoLeak(shared.raw, 'jobs B', f.rates.b2, f.jobs.b2, LOC_2)
})

route('POST /:id/jobs', async (f) => {
	const body = (scopeId: string, positionId: string) => ({
		scopeId,
		positionId,
		currency: 'USD',
		rateMinor: 1,
		effectiveFrom: '2026-02-01',
	})
	expectStatus(
		await call(f, {
			method: 'POST',
			path: `/${f.c.id}/jobs`,
			body: body(LOC_2, f.positions.p3),
		}),
		[403, 404],
		'job for C',
	)
	for (const [person, scopeId] of [
		[f.a, LOC_2],
		[f.b, LOC_2],
		[f.a, LOC_3],
	] as const) {
		expectStatus(
			await call(f, {
				method: 'POST',
				path: `/${person.id}/jobs`,
				body: body(scopeId, f.positions.p1),
			}),
			403,
			`job at ${scopeId}`,
		)
	}
})

route('POST /:id/jobs/:jobId/rate-change', async (f) => {
	const body = { effectiveFrom: '2026-06-01', rateMinor: 1, reason: 'attack' }
	for (const [person, jobId, label] of [
		[f.c, f.jobs.c, "C's own job"],
		[f.b, f.jobs.b2, "B's LOC_2 job"],
		// IDOR: a job id that belongs to someone else, under a visible person.
		[f.a, f.jobs.c, "C's job under A"],
		[f.a, f.jobs.b2, "B's LOC_2 job under A"],
	] as const) {
		expectStatus(
			await call(f, {
				method: 'POST',
				path: `/${person.id}/jobs/${jobId}/rate-change`,
				body,
			}),
			404,
			label,
		)
	}
})

route('GET /:id/assignments', async (f) => {
	expectStatus(
		await call(f, { method: 'GET', path: `/${f.c.id}/assignments` }),
		404,
		'assignments C',
	)
	const shared = await call(f, {
		method: 'GET',
		path: `/${f.b.id}/assignments`,
	})
	expect(shared.body.assignments.map((x: any) => x.scopeId)).toEqual([LOC_1])
	expectNoLeak(shared.raw, 'assignments B', LOC_2, f.b.assignments[LOC_2]!)
})

route('POST /:id/assignments', async (f) => {
	expectStatus(
		await call(f, {
			method: 'POST',
			path: `/${f.c.id}/assignments`,
			body: { scopeId: LOC_1 },
		}),
		404,
		'add LOC_1 to C',
	)
	for (const scopeId of [LOC_2, LOC_3]) {
		expectStatus(
			await call(f, {
				method: 'POST',
				path: `/${f.a.id}/assignments`,
				body: { scopeId },
			}),
			403,
			`add ${scopeId} to A`,
		)
	}
})

/** Every assignment-level route, aimed at assignments the scope cannot reach. */
async function attackAssignment(
	f: Fixture,
	method: string,
	suffix: string,
	body?: unknown,
) {
	const targets: Array<[string, string, string]> = [
		[f.c.id, f.c.assignments[LOC_2]!, "C's assignment"],
		[f.b.id, f.b.assignments[LOC_2]!, "B's LOC_2 assignment"],
		// IDOR: another person's assignment id under a visible person.
		[f.a.id, f.c.assignments[LOC_2]!, "C's assignment under A"],
		[f.a.id, f.b.assignments[LOC_2]!, "B's LOC_2 assignment under A"],
		[f.b.id, f.a.assignments[LOC_1]!, "A's assignment under B"],
	]
	for (const [personId, assignmentId, label] of targets) {
		const response = await call(f, {
			method,
			path: `/${personId}/assignments/${assignmentId}${suffix}`,
			body,
		})
		expectStatus(response, 404, `${method} ${suffix} ${label}`)
	}
}

route('PATCH /:id/assignments/:assignmentId', (f) =>
	attackAssignment(f, 'PATCH', '', { active: false }),
)
route('DELETE /:id/assignments/:assignmentId', (f) =>
	attackAssignment(f, 'DELETE', ''),
)
route('POST /:id/assignments/:assignmentId/pin', (f) =>
	attackAssignment(f, 'POST', '/pin', {}),
)
route('DELETE /:id/assignments/:assignmentId/pin', (f) =>
	attackAssignment(f, 'DELETE', '/pin'),
)

route('POST /:id/terminate', async (f) => {
	expectStatus(
		await call(f, {
			method: 'POST',
			path: `/${f.c.id}/terminate`,
			body: { reason: 'attack' },
		}),
		404,
		'terminate C',
	)
	expectStatus(
		await call(f, {
			method: 'POST',
			path: `/${f.b.id}/terminate`,
			body: { reason: 'attack' },
		}),
		403,
		'terminate B',
	)
})

route('POST /:id/rehire', async (f) => {
	// Someone ended outside the scope, and someone shared who was ended by an
	// unrestricted manager: the scoped manager may not bring either back.
	const admin = await mintStaffToken({ grants: ADMIN_GRANTS })
	for (const person of [f.c, f.b]) {
		expect(
			(
				await f.h.request('POST', `/${person.id}/terminate`, {
					token: admin,
					body: { reason: 'setup' },
				})
			).status,
		).toBe(200)
	}
	expectStatus(
		await call(f, {
			method: 'POST',
			path: `/${f.c.id}/rehire`,
			body: { reason: 'attack' },
		}),
		404,
		'rehire C',
	)
	expectStatus(
		await call(f, {
			method: 'POST',
			path: `/${f.b.id}/rehire`,
			body: { reason: 'attack' },
		}),
		403,
		'rehire B',
	)
})

route('GET /:id/notes', async (f) => {
	const other = await call(f, { method: 'GET', path: `/${f.c.id}/notes` })
	expectStatus(other, 404, 'notes C')
	expectNoLeak(other.raw, 'notes C', 'secret note about Carim')
})

route('POST /:id/notes', async (f) => {
	expectStatus(
		await call(f, {
			method: 'POST',
			path: `/${f.c.id}/notes`,
			body: { body: 'attack' },
		}),
		404,
		'note on C',
	)
})

route('DELETE /:id/notes/:noteId', async (f) => {
	expectStatus(
		await call(f, { method: 'DELETE', path: `/${f.c.id}/notes/${f.notes.c}` }),
		404,
		'delete C note',
	)
	// IDOR: C's note id under a visible person.
	expectStatus(
		await call(f, { method: 'DELETE', path: `/${f.a.id}/notes/${f.notes.c}` }),
		404,
		'delete C note via A',
	)
})

// ---------------------------------------------------------------------------

async function rosterCount(f: Fixture) {
	const db = await getTenantDb(ORG_A)
	return (await db.select().from(staffMembers)).length
}

/** A stable picture of every staff table except the append-only audit log. */
async function digest() {
	const db = await getTenantDb(ORG_A)
	const sorted = <T extends { id?: string }>(rows: T[]) =>
		[...rows].sort((x, y) => String(x.id).localeCompare(String(y.id)))
	return JSON.stringify({
		members: sorted(await db.select().from(staffMembers)),
		assignments: sorted(await db.select().from(staffScopeAssignments)),
		jobs: sorted(await db.select().from(staffJobs)),
		positions: sorted(await db.select().from(staffPositions)),
		notes: sorted(await db.select().from(staffNotes)),
		settings: sorted(await db.select().from(staffingSettings)),
		private: await db.select().from(staffPrivate),
	})
}

async function seed(h: StaffHarness): Promise<Fixture> {
	const admin = await mintStaffToken({ grants: ADMIN_GRANTS })
	const make = async (
		firstName: string,
		employeeNumber: string,
		phone: string | undefined,
		assignments: Array<{ scopeId: string; isPrimary?: boolean }>,
	) => {
		const response = await h.request('POST', '/', {
			token: admin,
			body: staffBody({
				firstName,
				lastName: 'Test',
				email: `${firstName.toLowerCase()}@example.com`,
				phone,
				employeeNumber,
				assignments,
			}),
		})
		expect(response.status, `seed ${firstName}`).toBe(201)
		const assignmentsByScope: Record<string, string> = {}
		for (const assignment of response.body.assignments) {
			assignmentsByScope[assignment.scopeId] = assignment.id
		}
		return {
			id: response.body.staff.id as string,
			assignments: assignmentsByScope,
		}
	}
	const a = await make('Alma', 'EMP-A', '+14155550101', [
		{ scopeId: LOC_1, isPrimary: true },
	])
	const b = await make('Basem', 'EMP-B', '+14155550103', [
		{ scopeId: LOC_1, isPrimary: true },
		{ scopeId: LOC_2 },
	])
	const c = await make('Carim', 'EMP-C', '+14155550102', [
		{ scopeId: LOC_2, isPrimary: true },
	])
	const d = await make('Dina', 'EMP-D', undefined, [])

	const position = async (name: string) => {
		const response = await h.request('POST', '/positions', {
			token: admin,
			body: { name },
		})
		expect(response.status).toBe(201)
		return response.body.position.id as string
	}
	const positions = {
		p1: await position('Server'),
		p2: await position('Cook'),
		p3: await position('Runner'),
	}
	const rates = { b1: 1111, b2: HIDDEN_RATE_B2, c: HIDDEN_RATE_C }
	const job = async (
		person: Person,
		scopeId: string,
		positionId: string,
		rateMinor: number,
	) => {
		const response = await h.request('POST', `/${person.id}/jobs`, {
			token: admin,
			body: {
				scopeId,
				positionId,
				currency: 'USD',
				rateMinor,
				isPrimary: true,
				effectiveFrom: '2026-01-01',
			},
		})
		expect(response.status, `job ${rateMinor}`).toBe(201)
		return response.body.job.id as string
	}
	const jobs = {
		b1: await job(b, LOC_1, positions.p1, rates.b1),
		b2: await job(b, LOC_2, positions.p2, rates.b2),
		c: await job(c, LOC_2, positions.p3, rates.c),
	}
	await job(a, LOC_1, positions.p1, 1500)

	for (const person of [a, b, c]) {
		await h.request('PUT', `/${person.id}/private`, {
			token: admin,
			body: { city: 'Springfield', addressLine1: '77 Secret Lane' },
		})
	}
	const note = async (person: Person, body: string) => {
		const response = await h.request('POST', `/${person.id}/notes`, {
			token: admin,
			body: { body },
		})
		expect(response.status).toBe(201)
		return response.body.note.id as string
	}
	const notes = {
		a: await note(a, 'note about Alma'),
		c: await note(c, 'secret note about Carim'),
	}
	// PINs exist at the other scope, so a clear or reset would show.
	for (const [person, scopeId] of [
		[c, LOC_2],
		[b, LOC_2],
	] as const) {
		const response = await h.request(
			'POST',
			`/${person.id}/assignments/${person.assignments[scopeId]}/pin`,
			{ token: admin, body: {} },
		)
		expect(response.status).toBe(201)
	}

	return {
		h,
		scoped: await mintStaffToken({
			grants: ADMIN_GRANTS,
			scopeIds: [LOC_1],
		}),
		a,
		b,
		c,
		d,
		positions,
		jobs,
		notes,
		rates,
	}
}

describe('Adversarial: /operator/staff scope limit, route by route', () => {
	let h: StaffHarness

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		h = await createStaffHarness()
	})

	afterEach(async () => {
		await h.cleanup()
		vi.unstubAllEnvs()
	})

	it('has a case for every route on the router, and none for routes that do not exist', () => {
		const registered = staffOperatorRoutes.routes
			.filter((r) => r.method !== 'ALL')
			.map((r) => `${r.method} ${r.path}`)
		expect([...new Set(registered)].sort()).toEqual(Object.keys(CASES).sort())
	})

	for (const [key, run] of Object.entries(CASES)) {
		it(`${key}: a LOC_1-only token cannot reach LOC_2 data`, async () => {
			const fixture = await seed(h)
			const before = await digest()
			await run(fixture)
			// Setup inside a case (terminating people) is the only allowed change;
			// every other case must leave the tables exactly as they were.
			if (key !== 'POST /:id/rehire' && key !== 'POST /bulk') {
				expect(await digest(), `${key} changed data`).toEqual(before)
			}
		})
	}

	it('leaves the other scope untouched after the whole barrage', async () => {
		const fixture = await seed(h)
		const before = await digest()
		for (const [key, run] of Object.entries(CASES)) {
			if (key === 'POST /:id/rehire' || key === 'POST /bulk') continue
			await run(fixture)
		}
		expect(await digest()).toEqual(before)
	})

	it('the same calls succeed for an unrestricted token (the cases are not vacuous)', async () => {
		const fixture = await seed(h)
		const admin = await mintStaffToken({ grants: ADMIN_GRANTS })
		const list = await h.request('GET', '/?limit=200', { token: admin })
		expect(list.body.total).toBe(4)
		for (const person of [fixture.a, fixture.b, fixture.c, fixture.d]) {
			expect(
				(await h.request('GET', `/${person.id}`, { token: admin })).status,
			).toBe(200)
		}
		const c = await h.request('GET', `/${fixture.c.id}?include=pay`, {
			token: admin,
		})
		expect(c.raw).toContain(String(fixture.rates.c))
		expect(
			(await h.request('GET', `/${fixture.c.id}/notes`, { token: admin })).raw,
		).toContain('secret note about Carim')
		expect((await h.request('GET', '/export', { token: admin })).status).toBe(
			200,
		)
		const audit = await h.request('GET', '/audit?limit=200', { token: admin })
		expect(audit.body.entries.some((e: any) => e.scopeId === LOC_2)).toBe(true)
	})

	it('the symmetric token (LOC_2 only) sees the other half and none of LOC_1', async () => {
		const fixture = await seed(h)
		const token = await mintStaffToken({
			grants: ADMIN_GRANTS,
			scopeIds: [LOC_2],
		})
		const list = await h.request('GET', '/?limit=200&include=pay', { token })
		expect(list.body.staff.map((s: any) => s.firstName).sort()).toEqual([
			'Basem',
			'Carim',
		])
		expectNoLeak(
			list.raw,
			'LOC_2 list',
			'Alma',
			'Dina',
			fixture.rates.b1,
			LOC_1,
		)
		expect((await h.request('GET', `/${fixture.a.id}`, { token })).status).toBe(
			404,
		)
	})

	it('a token for a scope nobody works at, or no scope at all, reaches no person', async () => {
		const fixture = await seed(h)
		const before = await digest()
		for (const scopeIds of [[LOC_3], ['nonexistent'], []]) {
			const token = await mintStaffToken({
				grants: ADMIN_GRANTS,
				scopeIds,
			})
			const list = await h.request('GET', '/?limit=200', { token })
			expect(list.body.staff, JSON.stringify(scopeIds)).toEqual([])
			expect(list.body.total).toBe(0)
			for (const person of [fixture.a, fixture.b, fixture.c, fixture.d]) {
				for (const [method, path, body] of [
					['GET', `/${person.id}`],
					['GET', `/${person.id}/notes`],
					['GET', `/${person.id}/jobs`],
					['GET', `/${person.id}/private`],
					['GET', `/${person.id}/assignments`],
					['PATCH', `/${person.id}`, { firstName: 'X' }],
					['POST', `/${person.id}/notes`, { body: 'x' }],
					['POST', `/${person.id}/terminate`, { reason: 'x' }],
				] as Array<[string, string, unknown?]>) {
					const response = await h.request(method, path, { token, body })
					expect(
						response.status,
						`${method} ${path} ${JSON.stringify(scopeIds)}`,
					).toBe(404)
				}
			}
			const audit = await h.request('GET', '/audit?limit=200', { token })
			expect(audit.body.entries).toEqual([])
			expect(
				(await h.request('POST', '/', { token, body: staffBody() })).status,
			).toBe(403)
		}
		expect(await digest()).toEqual(before)
	})

	it('a scoped manager cannot widen their own scope through any request field', async () => {
		const fixture = await seed(h)
		const before = await digest()
		// The scope comes only from the signed token: neither a header, a query
		// parameter nor a body field can change it.
		const headers = {
			'x-scope-ids': LOC_2,
			'x-scope-id': LOC_2,
		}
		for (const path of [
			`/?scopeIds=${LOC_2}&scopeId=${LOC_2}&limit=200`,
			`/${fixture.c.id}?scopeIds=${LOC_2}`,
		]) {
			const response = await h.request('GET', path, {
				token: fixture.scoped,
				headers,
			})
			expectNoLeak(response.raw, path, 'Carim', fixture.c.id)
		}
		const create = await h.request('POST', '/', {
			token: fixture.scoped,
			headers,
			body: staffBody({
				assignments: [{ scopeId: LOC_2 }],
				scopeIds: [LOC_2],
			}),
		})
		expect([400, 403]).toContain(create.status)
		expect(await digest()).toEqual(before)
	})

	it('does not reveal an out-of-scope primary scope on a shared person', async () => {
		const fixture = await seed(h)
		const admin = await mintStaffToken({ grants: ADMIN_GRANTS })
		const moved = await h.request('PATCH', `/${fixture.b.id}`, {
			token: admin,
			body: { primaryScopeId: LOC_2 },
		})
		expect(moved.status).toBe(200)
		const detail = await h.request('GET', `/${fixture.b.id}`, {
			token: fixture.scoped,
		})
		expect(detail.body.staff.primaryScopeId).toBeNull()
		expectNoLeak(detail.raw, 'detail', LOC_2)
		const list = await h.request('GET', '/?limit=200', {
			token: fixture.scoped,
		})
		const row = list.body.staff.find((s: any) => s.id === fixture.b.id)
		expect(row.primaryScopeId).toBeNull()
		expectNoLeak(list.raw, 'list', LOC_2)
		// The audit row for the move names LOC_2 only in a redacted form.
		const audit = await h.request('GET', '/audit?limit=200', {
			token: fixture.scoped,
		})
		expectNoLeak(audit.raw, 'audit', LOC_2)
	})

	it('withholds out-of-scope limit ids from the changes of audit rows it may read', async () => {
		const fixture = await seed(h)
		const audit = await h.request('GET', '/audit?limit=200', {
			token: fixture.scoped,
		})
		const created = audit.body.entries.find(
			(e: any) => e.action === 'staff.created' && e.staffId === fixture.b.id,
		)
		// B was created at both scopes; the LOC_1 manager sees only LOC_1.
		expect(created.changes.scopes).toEqual([LOC_1])
	})
})

describe('redactChangesForScope', () => {
	const scoped = scopeToScopes({ scopeIds: [LOC_1] })

	it('keeps only in-scope ids in a scopes list', () => {
		expect(
			redactChangesForScope({ scopes: [LOC_1, LOC_2, LOC_3] }, scoped),
		).toEqual({ scopes: [LOC_1] })
	})

	it('nulls out-of-scope primary and scope ids, including before/after pairs', () => {
		expect(
			redactChangesForScope(
				{
					primaryScopeId: { before: LOC_2, after: LOC_1 },
					scopeId: LOC_3,
				},
				scoped,
			),
		).toEqual({
			primaryScopeId: { before: null, after: LOC_1 },
			scopeId: null,
		})
	})

	it('leaves everything else, and unrestricted scopes, alone', () => {
		const changes = { rateMinor: 1500, note: LOC_2, scopes: [LOC_1, LOC_2] }
		expect(redactChangesForScope(changes, scoped)).toEqual({
			rateMinor: 1500,
			note: LOC_2,
			scopes: [LOC_1],
		})
		expect(
			redactChangesForScope(changes, scopeToScopes({ scopeIds: null })),
		).toBe(changes)
		expect(redactChangesForScope(null, scoped)).toBeNull()
		expect(redactChangesForScope(undefined, scoped)).toBeUndefined()
	})

	it('removes everything for an empty scope', () => {
		const none = scopeToScopes({ scopeIds: [] })
		expect(redactChangesForScope({ scopes: [LOC_1] }, none)).toEqual({
			scopes: [],
		})
	})
})
