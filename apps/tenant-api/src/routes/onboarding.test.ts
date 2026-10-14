import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	hiringApplications,
	onboardingTasks,
	onboardingTemplates,
	onboardingTemplateTasks,
	staffAuditLog,
	staffCertificates,
	staffScopeAssignments,
	staffMembers,
	staffPositions,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	createHiringHarness,
	HIRING_GRANTS,
	HIRING_READ_GRANTS,
	LOC_1,
	LOC_2,
	makeOrg,
	ORG_A,
	ORG_B,
	seedApplication,
	type HiringHarness,
	type TestOrg,
} from '../../tests/hiring-harness.ts'
import { hiringDeps } from '../services/hiring-service.ts'
import { onboardingDeps } from '../services/onboarding-service.ts'

const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0)
const originalHiring = { ...hiringDeps }
const originalOnboarding = { ...onboardingDeps }

const taskInput = (extra: Record<string, unknown> = {}) => ({
	type: 'custom',
	title: 'Hand in the signed rota',
	dueInDays: 3,
	...extra,
})

const templateBody = (extra: Record<string, unknown> = {}) => ({
	name: 'Kitchen start',
	isDefault: false,
	tasks: [
		taskInput({
			title: 'Confirm your details',
			type: 'review_profile',
			dueInDays: 0,
		}),
		taskInput({
			title: 'Read the hygiene policy',
			type: 'acknowledge_policy',
			instructions: 'Wash hands. Wear a hat.',
			dueInDays: 2,
		}),
		taskInput({
			title: 'Fill in the allergen form',
			type: 'form_link',
			linkUrl: 'https://forms.example.com/allergen',
			dueInDays: 5,
			assignee: 'staff',
		}),
	],
	...extra,
})

describe('/operator/hiring/onboarding and /certificates', () => {
	let h: HiringHarness

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		h = await createHiringHarness()
		hiringDeps.now = () => NOW
		hiringDeps.emailEnabled = () => false
		hiringDeps.getOrganizationName = async () => 'Acme Kitchen'
		hiringDeps.getScope = async () => ({
			name: 'Downtown',
			timeZone: 'America/Chicago',
		})
		onboardingDeps.now = () => NOW
	})

	afterEach(async () => {
		Object.assign(hiringDeps, originalHiring)
		Object.assign(onboardingDeps, originalOnboarding)
		await h.cleanup()
		vi.unstubAllEnvs()
	})

	const db = () => h.db(ORG_A)

	async function seedStaff(
		d: TenantDatabase,
		options: {
			scopeId?: string
			status?: 'active' | 'terminated'
			hiredDate?: string | null
			name?: string
		} = {},
	) {
		const scopeId = options.scopeId ?? LOC_1
		const [staff] = await d
			.insert(staffMembers)
			.values({
				firstName: options.name ?? 'Sara',
				lastName: 'Ali',
				primaryScopeId: scopeId,
				status: options.status ?? 'active',
				hiredDate:
					options.hiredDate === undefined ? '2026-10-10' : options.hiredDate,
			})
			.returning()
		await d.insert(staffScopeAssignments).values({
			staffId: staff!.id,
			scopeId,
			isPrimary: true,
		})
		return staff!
	}

	describe('authentication and grants', () => {
		const paths: Array<[string, string]> = [
			['GET', '/onboarding/templates'],
			['GET', '/onboarding/summary'],
			['GET', '/onboarding/staff/abc/tasks'],
			['GET', '/certificates/staff/abc'],
		]

		it('needs a token', async () => {
			for (const [method, path] of paths) {
				expect((await h.operator(method, path, { token: null })).status).toBe(
					401,
				)
			}
		})

		it('refuses tokens of another scope and tokens without a hiring grant', async () => {
			for (const [method, path] of paths) {
				expect(
					(await h.operator(method, path, { scope: 'staff' })).status,
				).toBe(403)
				expect((await h.operator(method, path, { grants: [] })).status).toBe(
					403,
				)
			}
		})

		it('lets a reader read but not change anything', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			const read = { grants: HIRING_READ_GRANTS }
			expect(
				(await h.operator('GET', '/onboarding/templates', read)).status,
			).toBe(200)
			const writes: Array<[string, string, unknown]> = [
				['POST', '/onboarding/templates', templateBody()],
				['PUT', '/onboarding/templates/abc', templateBody()],
				['DELETE', '/onboarding/templates/abc', undefined],
				['POST', `/onboarding/staff/${staff.id}/tasks`, taskInput()],
				['POST', `/onboarding/staff/${staff.id}/apply`, {}],
				[
					'PATCH',
					`/onboarding/staff/${staff.id}/tasks/abc`,
					{ status: 'done' },
				],
				['DELETE', `/onboarding/staff/${staff.id}/tasks/abc`, undefined],
				['POST', `/certificates/staff/${staff.id}`, { kind: 'food_handler' }],
				['PATCH', `/certificates/staff/${staff.id}/abc`, { note: 'x' }],
				['DELETE', `/certificates/staff/${staff.id}/abc`, undefined],
			]
			for (const [method, path, body] of writes) {
				const reply = await h.operator(method, path, { ...read, body })
				expect(reply.status, `${method} ${path}`).toBe(403)
			}
		})

		it('refuses writes from an impersonated session', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			const reply = await h.operator(
				'POST',
				`/onboarding/staff/${staff.id}/tasks`,
				{ impersonated: true, body: taskInput() },
			)
			expect(reply.status).toBe(403)
			expect(await d.select().from(onboardingTasks)).toHaveLength(0)
		})

		it('never caches', async () => {
			const reply = await h.operator('GET', '/onboarding/templates')
			expect(reply.headers.get('cache-control')).toBe('private, no-store')
		})
	})

	describe('templates', () => {
		it('creates, lists and replaces a template, keeping task order', async () => {
			const created = await h.operator('POST', '/onboarding/templates', {
				body: templateBody(),
			})
			expect(created.status).toBe(201)
			const template = created.body.template
			expect(template.tasks.map((t: { title: string }) => t.title)).toEqual([
				'Confirm your details',
				'Read the hygiene policy',
				'Fill in the allergen form',
			])
			expect(template.tasks[2]).toMatchObject({
				type: 'form_link',
				linkUrl: 'https://forms.example.com/allergen',
				assignee: 'staff',
			})

			const replaced = await h.operator(
				'PUT',
				`/onboarding/templates/${template.id}`,
				{
					body: templateBody({
						name: 'Renamed',
						tasks: [taskInput({ title: 'Only one' })],
					}),
				},
			)
			expect(replaced.status).toBe(200)
			expect(replaced.body.template.name).toBe('Renamed')
			expect(replaced.body.template.tasks).toHaveLength(1)

			const list = await h.operator('GET', '/onboarding/templates')
			expect(list.body.templates).toHaveLength(1)
			// The replaced tasks are gone, not orphaned.
			expect(
				await (await db()).select().from(onboardingTemplateTasks),
			).toHaveLength(1)
		})

		it('keeps at most one live default', async () => {
			const first = await h.operator('POST', '/onboarding/templates', {
				body: templateBody({ name: 'A', isDefault: true }),
			})
			const second = await h.operator('POST', '/onboarding/templates', {
				body: templateBody({ name: 'B', isDefault: true }),
			})
			expect(first.status).toBe(201)
			expect(second.status).toBe(201)
			const rows = await (await db()).select().from(onboardingTemplates)
			expect(
				rows.filter((row) => row.isDefault).map((row) => row.name),
			).toEqual(['B'])
			// Making the first one the default again moves the flag.
			const back = await h.operator(
				'PUT',
				`/onboarding/templates/${first.body.template.id}`,
				{ body: templateBody({ name: 'A', isDefault: true }) },
			)
			expect(back.status).toBe(200)
			const after = await (await db()).select().from(onboardingTemplates)
			expect(
				after.filter((row) => row.isDefault).map((row) => row.name),
			).toEqual(['A'])
		})

		it('archives a template without touching checklists copied from it', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			const created = await h.operator('POST', '/onboarding/templates', {
				body: templateBody({ isDefault: true }),
			})
			const id = created.body.template.id
			const applied = await h.operator(
				'POST',
				`/onboarding/staff/${staff.id}/apply`,
				{ body: { templateId: id } },
			)
			expect(applied.status).toBe(201)
			const archived = await h.operator('DELETE', `/onboarding/templates/${id}`)
			expect(archived.status).toBe(200)
			expect(
				(await h.operator('GET', '/onboarding/templates')).body.templates,
			).toEqual([])
			const checklist = await h.operator(
				'GET',
				`/onboarding/staff/${staff.id}/tasks`,
			)
			expect(checklist.body.tasks).toHaveLength(3)
			// An archived template cannot be applied or edited, and loses default.
			expect(
				(
					await h.operator('POST', `/onboarding/staff/${staff.id}/apply`, {
						body: { templateId: id },
					})
				).status,
			).toBe(404)
			expect(
				(
					await h.operator('PUT', `/onboarding/templates/${id}`, {
						body: templateBody(),
					})
				).status,
			).toBe(404)
			const [row] = await d.select().from(onboardingTemplates)
			expect(row).toMatchObject({ isDefault: false })
			expect(row!.archivedAt).toBe(NOW)
		})

		it('needs a token that covers every scope to change a template', async () => {
			const scoped = { scopeIds: [LOC_1] }
			expect(
				(
					await h.operator('POST', '/onboarding/templates', {
						...scoped,
						body: templateBody(),
					})
				).status,
			).toBe(403)
			const created = await h.operator('POST', '/onboarding/templates', {
				body: templateBody(),
			})
			const id = created.body.template.id
			expect(
				(
					await h.operator('PUT', `/onboarding/templates/${id}`, {
						...scoped,
						body: templateBody(),
					})
				).status,
			).toBe(403)
			expect(
				(await h.operator('DELETE', `/onboarding/templates/${id}`, scoped))
					.status,
			).toBe(403)
			// Reading is fine: a template holds no personal data.
			expect(
				(await h.operator('GET', '/onboarding/templates', scoped)).body
					.templates,
			).toHaveLength(1)
		})

		it('limits how many live templates there are', async () => {
			const d = await db()
			await d
				.insert(onboardingTemplates)
				.values(Array.from({ length: 25 }, (_, i) => ({ name: `T${i}` })))
			const reply = await h.operator('POST', '/onboarding/templates', {
				body: templateBody(),
			})
			expect(reply.status).toBe(409)
			expect(reply.body.error).toBe('template_limit')
		})

		it('rejects unsafe or malformed templates without echoing them', async () => {
			const bad: unknown[] = [
				templateBody({ tasks: [] }),
				templateBody({ tasks: [taskInput({ type: 'upload_document' })] }),
				templateBody({
					tasks: [
						taskInput({
							type: 'form_link',
							linkUrl: 'javascript:alert(document.cookie)',
						}),
					],
				}),
				templateBody({
					tasks: [taskInput({ title: '<img src=x onerror=1>' })],
				}),
				templateBody({ tasks: [taskInput({ ssn: '123-45-6789' })] }),
				{ ...templateBody(), taxId: '1' },
			]
			for (const body of bad) {
				const reply = await h.operator('POST', '/onboarding/templates', {
					body,
				})
				expect(reply.status).toBe(400)
				expect(reply.raw).not.toContain('javascript:alert')
				expect(reply.raw).not.toContain('123-45-6789')
			}
			expect(
				await (await db()).select().from(onboardingTemplates),
			).toHaveLength(0)
			expect(
				(
					await h.operator('POST', '/onboarding/templates', {
						rawBody: '{not json',
					})
				).status,
			).toBe(400)
		})

		it('treats a malformed id as not found', async () => {
			for (const id of ['..%2f', 'a'.repeat(65), "x'--"]) {
				expect(
					(
						await h.operator('PUT', `/onboarding/templates/${id}`, {
							body: templateBody(),
						})
					).status,
				).toBe(404)
			}
		})

		it('audits ids and counts, never titles, policy text or links', async () => {
			await h.operator('POST', '/onboarding/templates', {
				body: templateBody({ isDefault: true }),
			})
			const rows = await (await db()).select().from(staffAuditLog)
			const row = rows.find((r) => r.action === 'onboarding.template.created')
			expect(row?.changes).toEqual({ tasks: 3, isDefault: true })
			const dump = JSON.stringify(rows)
			for (const secret of [
				'hygiene',
				'Wash hands',
				'forms.example.com',
				'Kitchen start',
			]) {
				expect(dump).not.toContain(secret)
			}
		})
	})

	describe('auto-attach on hire', () => {
		async function hire(body: Record<string, unknown> = {}) {
			const d = await db()
			const [position] = await d
				.insert(staffPositions)
				.values({ name: 'Line cook' })
				.returning()
			const app = await seedApplication(d, { stage: 'offer' })
			const reply = await h.operator('POST', `/applications/${app.id}/hire`, {
				body: {
					scopeId: LOC_1,
					positionId: position!.id,
					hiredDate: '2026-10-20',
					currency: 'USD',
					...body,
				},
			})
			return { reply, d, app }
		}

		it('uses the built-in list when there is no default template', async () => {
			const { reply, d } = await hire()
			expect(reply.status).toBe(201)
			expect(reply.body.onboardingTasks).toBe(5)
			const tasks = await d.select().from(onboardingTasks)
			expect(tasks[0]).toMatchObject({
				taskKey: 'confirm_contact',
				type: 'review_profile',
				source: 'hire',
				assignee: 'manager',
			})
		})

		it('copies the default template with due dates counted from the hire date', async () => {
			await h.operator('POST', '/onboarding/templates', {
				body: templateBody({ isDefault: true }),
			})
			const { reply, d } = await hire()
			expect(reply.status).toBe(201)
			expect(reply.body.onboardingTasks).toBe(3)
			const tasks = (await d.select().from(onboardingTasks)).sort(
				(a, b) => a.sortOrder - b.sortOrder,
			)
			expect(tasks.map((t) => [t.title, t.dueDate, t.type, t.source])).toEqual([
				['Confirm your details', '2026-10-20', 'review_profile', 'hire'],
				['Read the hygiene policy', '2026-10-22', 'acknowledge_policy', 'hire'],
				['Fill in the allergen form', '2026-10-25', 'form_link', 'hire'],
			])
			expect(tasks[2]).toMatchObject({
				linkUrl: 'https://forms.example.com/allergen',
				assignee: 'staff',
			})
			expect(tasks[0]!.taskKey).toBeNull()
		})

		it('copies the template named in the hire, over the default', async () => {
			await h.operator('POST', '/onboarding/templates', {
				body: templateBody({ name: 'Default', isDefault: true }),
			})
			const other = await h.operator('POST', '/onboarding/templates', {
				body: templateBody({
					name: 'Bar',
					tasks: [taskInput({ title: 'Meet the bar lead' })],
				}),
			})
			const { reply, d } = await hire({ templateId: other.body.template.id })
			expect(reply.body.onboardingTasks).toBe(1)
			const tasks = await d.select().from(onboardingTasks)
			expect(tasks.map((t) => t.title)).toEqual(['Meet the bar lead'])
		})

		it('refuses the whole hire for an unknown or archived template', async () => {
			const created = await h.operator('POST', '/onboarding/templates', {
				body: templateBody(),
			})
			await h.operator(
				'DELETE',
				`/onboarding/templates/${created.body.template.id}`,
			)
			for (const templateId of [created.body.template.id, 'nope']) {
				const { reply, d, app } = await hire({ templateId })
				expect(reply.status).toBe(404)
				expect(await d.select().from(staffMembers)).toHaveLength(0)
				expect(await d.select().from(onboardingTasks)).toHaveLength(0)
				const [row] = await d
					.select()
					.from(hiringApplications)
					.where(eq(hiringApplications.id, app.id))
				expect(row!.stage).toBe('offer')
				await d.delete(staffPositions)
				await d.delete(hiringApplications)
			}
		})

		it('creates no checklist when asked not to', async () => {
			await h.operator('POST', '/onboarding/templates', {
				body: templateBody({ isDefault: true }),
			})
			const { reply, d } = await hire({ startOnboarding: false })
			expect(reply.body.onboardingTasks).toBe(0)
			expect(await d.select().from(onboardingTasks)).toHaveLength(0)
		})
	})

	describe("one person's checklist", () => {
		it('adds a task and returns the list in order', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			const first = await h.operator(
				'POST',
				`/onboarding/staff/${staff.id}/tasks`,
				{
					body: {
						type: 'custom',
						title: 'Order uniform',
						dueDate: '2026-10-20',
					},
				},
			)
			expect(first.status).toBe(201)
			expect(first.body.task).toMatchObject({
				title: 'Order uniform',
				status: 'todo',
				source: 'manual',
				dueDate: '2026-10-20',
				sortOrder: 0,
			})
			await h.operator('POST', `/onboarding/staff/${staff.id}/tasks`, {
				body: { type: 'custom', title: 'Second' },
			})
			const list = await h.operator(
				'GET',
				`/onboarding/staff/${staff.id}/tasks`,
			)
			expect(list.body.tasks.map((t: { title: string }) => t.title)).toEqual([
				'Order uniform',
				'Second',
			])
		})

		it('completes, skips and reopens a task, recording who and when', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			const created = await h.operator(
				'POST',
				`/onboarding/staff/${staff.id}/tasks`,
				{ body: { type: 'custom', title: 'Order uniform' } },
			)
			const path = `/onboarding/staff/${staff.id}/tasks/${created.body.task.id}`
			const done = await h.operator('PATCH', path, { body: { status: 'done' } })
			expect(done.body.task).toMatchObject({
				status: 'done',
				completedAt: NOW,
				completedBy: 'operator-1',
			})
			const skipped = await h.operator('PATCH', path, {
				body: { status: 'skipped' },
			})
			expect(skipped.body.task.status).toBe('skipped')
			const reopened = await h.operator('PATCH', path, {
				body: { status: 'todo' },
			})
			expect(reopened.body.task).toMatchObject({
				status: 'todo',
				completedAt: null,
				completedBy: null,
			})
			const audit = (await d.select().from(staffAuditLog))
				.filter((r) => r.action === 'onboarding.task.updated')
				.map((r) => r.changes)
			expect(audit).toEqual([
				{ fields: ['status'], from: 'todo', to: 'done' },
				{ fields: ['status'], from: 'done', to: 'skipped' },
				{ fields: ['status'], from: 'skipped', to: 'todo' },
			])
		})

		it('resets reminders when the due date moves or a task is reopened', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			const created = await h.operator(
				'POST',
				`/onboarding/staff/${staff.id}/tasks`,
				{ body: { type: 'custom', title: 'X', dueDate: '2026-10-01' } },
			)
			const id = created.body.task.id
			await d
				.update(onboardingTasks)
				.set({ remindedStage: 2 })
				.where(eq(onboardingTasks.id, id))
			await h.operator('PATCH', `/onboarding/staff/${staff.id}/tasks/${id}`, {
				body: { dueDate: '2026-11-01' },
			})
			const [row] = await d
				.select()
				.from(onboardingTasks)
				.where(eq(onboardingTasks.id, id))
			expect(row).toMatchObject({ remindedStage: 0, dueDate: '2026-11-01' })
		})

		it('keeps cross-field rules when editing', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			const created = await h.operator(
				'POST',
				`/onboarding/staff/${staff.id}/tasks`,
				{
					body: {
						type: 'form_link',
						title: 'Form',
						linkUrl: 'https://forms.example.com/a',
					},
				},
			)
			const path = `/onboarding/staff/${staff.id}/tasks/${created.body.task.id}`
			expect(
				(await h.operator('PATCH', path, { body: { linkUrl: null } })).status,
			).toBe(422)
			expect(
				(
					await h.operator('PATCH', path, {
						body: { assignee: 'member' },
					})
				).status,
			).toBe(422)
			const ok = await h.operator('PATCH', path, {
				body: { assignee: 'member', assigneeUserId: 'user_42' },
			})
			expect(ok.body.task).toMatchObject({
				assignee: 'member',
				assigneeUserId: 'user_42',
			})
			// Going back to a manager drops the member id.
			const back = await h.operator('PATCH', path, {
				body: { assignee: 'manager' },
			})
			expect(back.body.task).toMatchObject({
				assignee: 'manager',
				assigneeUserId: null,
			})
		})

		it('removes a task and 404s on a task from another person', async () => {
			const d = await db()
			const one = await seedStaff(d, { name: 'One' })
			const two = await seedStaff(d, { name: 'Two' })
			const created = await h.operator(
				'POST',
				`/onboarding/staff/${one.id}/tasks`,
				{ body: { type: 'custom', title: 'X' } },
			)
			const id = created.body.task.id
			expect(
				(await h.operator('DELETE', `/onboarding/staff/${two.id}/tasks/${id}`))
					.status,
			).toBe(404)
			expect(
				(
					await h.operator('PATCH', `/onboarding/staff/${two.id}/tasks/${id}`, {
						body: { status: 'done' },
					})
				).status,
			).toBe(404)
			expect(
				(await h.operator('DELETE', `/onboarding/staff/${one.id}/tasks/${id}`))
					.status,
			).toBe(200)
			expect(await d.select().from(onboardingTasks)).toHaveLength(0)
		})

		it('limits tasks per person', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			await d.insert(onboardingTasks).values(
				Array.from({ length: 60 }, (_, i) => ({
					staffId: staff.id,
					title: `T${i}`,
					sortOrder: i,
				})),
			)
			const reply = await h.operator(
				'POST',
				`/onboarding/staff/${staff.id}/tasks`,
				{ body: { type: 'custom', title: 'One too many' } },
			)
			expect(reply.status).toBe(409)
			expect(reply.body.error).toBe('task_limit')
		})

		it('does not add tasks for someone who has left, but still shows theirs', async () => {
			const d = await db()
			const staff = await seedStaff(d, { status: 'terminated' })
			const reply = await h.operator(
				'POST',
				`/onboarding/staff/${staff.id}/tasks`,
				{ body: { type: 'custom', title: 'X' } },
			)
			expect(reply.status).toBe(409)
			expect(
				(await h.operator('GET', `/onboarding/staff/${staff.id}/tasks`)).status,
			).toBe(200)
		})

		it('applies a template once, appending after existing tasks', async () => {
			const d = await db()
			const staff = await seedStaff(d, { hiredDate: '2026-10-10' })
			await h.operator('POST', `/onboarding/staff/${staff.id}/tasks`, {
				body: { type: 'custom', title: 'Existing' },
			})
			const template = await h.operator('POST', '/onboarding/templates', {
				body: templateBody(),
			})
			const body = { templateId: template.body.template.id }
			const applied = await h.operator(
				'POST',
				`/onboarding/staff/${staff.id}/apply`,
				{ body },
			)
			expect(applied.status).toBe(201)
			expect(applied.body.created).toBe(3)
			expect(
				applied.body.tasks.map(
					(t: { title: string; dueDate: string | null }) => [
						t.title,
						t.dueDate,
					],
				),
			).toEqual([
				['Existing', null],
				['Confirm your details', '2026-10-10'],
				['Read the hygiene policy', '2026-10-12'],
				['Fill in the allergen form', '2026-10-15'],
			])
			const again = await h.operator(
				'POST',
				`/onboarding/staff/${staff.id}/apply`,
				{ body },
			)
			expect(again.status).toBe(409)
			expect(again.body.error).toBe('template_already_applied')
			expect(await d.select().from(onboardingTasks)).toHaveLength(4)
		})

		it('applies the built-in list when there is no default, once', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			const first = await h.operator(
				'POST',
				`/onboarding/staff/${staff.id}/apply`,
				{ body: { baseDate: '2026-11-01' } },
			)
			expect(first.status).toBe(201)
			expect(first.body.created).toBe(5)
			expect(first.body.tasks[0]).toMatchObject({
				taskKey: 'confirm_contact',
				dueDate: '2026-11-01',
			})
			expect(
				(
					await h.operator('POST', `/onboarding/staff/${staff.id}/apply`, {
						body: {},
					})
				).status,
			).toBe(409)
		})

		it('refuses to apply past the per-person limit', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			await d.insert(onboardingTasks).values(
				Array.from({ length: 58 }, (_, i) => ({
					staffId: staff.id,
					title: `T${i}`,
					sortOrder: i,
				})),
			)
			const reply = await h.operator(
				'POST',
				`/onboarding/staff/${staff.id}/apply`,
				{ body: {} },
			)
			expect(reply.status).toBe(409)
			expect(reply.body.error).toBe('task_limit')
			expect(await d.select().from(onboardingTasks)).toHaveLength(58)
		})
	})

	describe('scope limit and organization isolation', () => {
		it('hides people (and their tasks and certificates) outside the token scope', async () => {
			const d = await db()
			const inScope = await seedStaff(d, { scopeId: LOC_1, name: 'In' })
			const outside = await seedStaff(d, { scopeId: LOC_2, name: 'Out' })
			await d
				.insert(onboardingTasks)
				.values({ staffId: outside.id, title: 'T' })
			await d
				.insert(staffCertificates)
				.values({ staffId: outside.id, kind: 'food_handler' })
			const scoped = { scopeIds: [LOC_1] }
			for (const [method, path, body] of [
				['GET', `/onboarding/staff/${outside.id}/tasks`, undefined],
				[
					'POST',
					`/onboarding/staff/${outside.id}/tasks`,
					{ type: 'custom', title: 'x' },
				],
				['POST', `/onboarding/staff/${outside.id}/apply`, {}],
				['GET', `/certificates/staff/${outside.id}`, undefined],
				['POST', `/certificates/staff/${outside.id}`, { kind: 'first_aid' }],
			] as const) {
				const reply = await h.operator(method, path, { ...scoped, body })
				expect(reply.status, `${method} ${path}`).toBe(404)
			}
			expect(
				(
					await h.operator(
						'GET',
						`/onboarding/staff/${inScope.id}/tasks`,
						scoped,
					)
				).status,
			).toBe(200)
			// Outside-scope and unknown look the same.
			const unknown = await h.operator(
				'GET',
				'/onboarding/staff/nobody/tasks',
				scoped,
			)
			const hidden = await h.operator(
				'GET',
				`/onboarding/staff/${outside.id}/tasks`,
				scoped,
			)
			expect(hidden.status).toBe(unknown.status)
			expect(hidden.body).toEqual(unknown.body)
		})

		it('summarizes only people in scope', async () => {
			const d = await db()
			const inScope = await seedStaff(d, { scopeId: LOC_1 })
			const outside = await seedStaff(d, { scopeId: LOC_2 })
			await d.insert(onboardingTasks).values([
				{ staffId: inScope.id, title: 'A' },
				{ staffId: outside.id, title: 'B' },
			])
			const all = await h.operator('GET', '/onboarding/summary')
			expect(all.body.entries).toHaveLength(2)
			const scoped = await h.operator('GET', '/onboarding/summary', {
				scopeIds: [LOC_1],
			})
			expect(
				scoped.body.entries.map((e: { staffId: string }) => e.staffId),
			).toEqual([inScope.id])
			const empty = await h.operator('GET', '/onboarding/summary', {
				scopeIds: [],
			})
			expect(empty.body.entries).toEqual([])
		})

		it('never reads or writes another organization', async () => {
			const a = await db()
			const b = await h.db(ORG_B)
			const staffA = await seedStaff(a)
			await a.insert(onboardingTasks).values({ staffId: staffA.id, title: 'A' })
			const reply = await h.operator(
				'GET',
				`/onboarding/staff/${staffA.id}/tasks`,
				{
					orgId: ORG_B,
				},
			)
			expect(reply.status).toBe(404)
			await h.operator('POST', '/onboarding/templates', {
				orgId: ORG_B,
				body: templateBody(),
			})
			expect(await a.select().from(onboardingTemplates)).toHaveLength(0)
			expect(await b.select().from(onboardingTemplates)).toHaveLength(1)
		})
	})

	describe('roster summary', () => {
		it('counts tasks, completed work and the earliest open due date', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			const none = await seedStaff(d, { name: 'None' })
			const left = await seedStaff(d, { status: 'terminated', name: 'Left' })
			await d.insert(onboardingTasks).values([
				{
					staffId: staff.id,
					title: 'a',
					status: 'done',
					dueDate: '2026-10-01',
				},
				{ staffId: staff.id, title: 'b', status: 'skipped' },
				{ staffId: staff.id, title: 'c', dueDate: '2026-10-20' },
				{ staffId: staff.id, title: 'd', dueDate: '2026-10-18' },
				{ staffId: left.id, title: 'e' },
			])
			const reply = await h.operator('GET', '/onboarding/summary')
			expect(reply.body.entries).toEqual([
				{ staffId: staff.id, total: 4, complete: 2, nextDueDate: '2026-10-18' },
			])
			expect(JSON.stringify(reply.body)).not.toContain(none.id)
			// Limited to the people on screen.
			const limited = await h.operator(
				'GET',
				`/onboarding/summary?staffIds=${none.id}`,
			)
			expect(limited.body.entries).toEqual([])
		})

		it('rejects a malformed list of ids', async () => {
			const reply = await h.operator(
				'GET',
				`/onboarding/summary?staffIds=${encodeURIComponent("a,b';drop table x;--")}`,
			)
			expect(reply.status).toBe(400)
		})
	})

	describe('certificates', () => {
		it('adds, updates and removes a certificate', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			const added = await h.operator(
				'POST',
				`/certificates/staff/${staff.id}`,
				{
					body: {
						kind: 'food_handler',
						issuedOn: '2025-11-01',
						expiresOn: '2026-11-01',
						note: 'County card',
					},
				},
			)
			expect(added.status).toBe(201)
			expect(added.body.certificate).toMatchObject({
				kind: 'food_handler',
				expiresOn: '2026-11-01',
			})
			const id = added.body.certificate.id
			const updated = await h.operator(
				'PATCH',
				`/certificates/staff/${staff.id}/${id}`,
				{ body: { expiresOn: '2027-11-01' } },
			)
			expect(updated.body.certificate.expiresOn).toBe('2027-11-01')
			const list = await h.operator('GET', `/certificates/staff/${staff.id}`)
			expect(list.body.certificates).toHaveLength(1)
			expect(
				(await h.operator('DELETE', `/certificates/staff/${staff.id}/${id}`))
					.status,
			).toBe(200)
			expect(await d.select().from(staffCertificates)).toHaveLength(0)
		})

		it('renewing resets the alert stage; other edits keep it', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			const [cert] = await d
				.insert(staffCertificates)
				.values({
					staffId: staff.id,
					kind: 'food_handler',
					expiresOn: '2026-10-01',
					alertStage: 2,
				})
				.returning()
			const path = `/certificates/staff/${staff.id}/${cert!.id}`
			await h.operator('PATCH', path, { body: { note: 'scan on file' } })
			expect((await d.select().from(staffCertificates))[0]!.alertStage).toBe(2)
			await h.operator('PATCH', path, { body: { expiresOn: '2027-10-01' } })
			expect((await d.select().from(staffCertificates))[0]!.alertStage).toBe(0)
		})

		it('keeps the date and label rules on update', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			const [cert] = await d
				.insert(staffCertificates)
				.values({
					staffId: staff.id,
					kind: 'food_handler',
					issuedOn: '2026-01-01',
					expiresOn: '2027-01-01',
				})
				.returning()
			const path = `/certificates/staff/${staff.id}/${cert!.id}`
			expect(
				(await h.operator('PATCH', path, { body: { expiresOn: '2025-12-31' } }))
					.status,
			).toBe(422)
			expect(
				(await h.operator('PATCH', path, { body: { kind: 'other' } })).status,
			).toBe(422)
			expect(
				(
					await h.operator('PATCH', path, {
						body: { kind: 'other', label: 'Barista' },
					})
				).status,
			).toBe(200)
		})

		it('refuses fields that could hold identity or document data', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			for (const extra of [
				{ number: 'FH-123' },
				{ nationalId: '1' },
				{ fileUrl: 'https://x.example.com/a.pdf' },
			]) {
				const reply = await h.operator(
					'POST',
					`/certificates/staff/${staff.id}`,
					{
						body: { kind: 'food_handler', ...extra },
					},
				)
				expect(reply.status).toBe(400)
			}
			expect(await d.select().from(staffCertificates)).toHaveLength(0)
		})

		it('limits certificates per person and scopes by scope', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			await d.insert(staffCertificates).values(
				Array.from({ length: 30 }, () => ({
					staffId: staff.id,
					kind: 'first_aid' as const,
				})),
			)
			const reply = await h.operator(
				'POST',
				`/certificates/staff/${staff.id}`,
				{
					body: { kind: 'first_aid' },
				},
			)
			expect(reply.status).toBe(409)
		})

		it('audits kind and whether there is an expiry, nothing else', async () => {
			const d = await db()
			const staff = await seedStaff(d)
			await h.operator('POST', `/certificates/staff/${staff.id}`, {
				body: { kind: 'other', label: 'Secret label', note: 'Secret note' },
			})
			const rows = await d.select().from(staffAuditLog)
			const row = rows.find((r) => r.action === 'staff.certificate.added')
			expect(row?.changes).toEqual({ kind: 'other', hasExpiry: false })
			const dump = JSON.stringify(rows)
			expect(dump).not.toContain('Secret')
		})
	})
})
