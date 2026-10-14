// @vitest-environment jsdom

import { addDays } from '@repo/staffing'
import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { localToday } from '#app/utils/staffing/onboarding-view.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { OnboardingTab } from './onboarding-tab.tsx'

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

type Call = { url: string; method: string; body: any }

const TODAY = localToday()
const GRANTS = ['read:staff:any', 'read:hiring:any', 'update:hiring:any']

function task(over: Record<string, unknown> = {}) {
	return {
		id: 't1',
		staffId: 's1',
		taskKey: null,
		title: 'Confirm your details',
		type: 'review_profile',
		instructions: null,
		linkUrl: null,
		assignee: 'manager',
		assigneeUserId: null,
		templateId: null,
		status: 'todo',
		dueDate: null,
		sortOrder: 0,
		source: 'hire',
		completedAt: null,
		completedBy: null,
		createdAt: 1,
		...over,
	}
}

function stubApi(
	options: {
		tasks?: unknown[]
		templates?: unknown[]
		grants?: string[]
		patchError?: Response
		postError?: Response
	} = {},
) {
	const calls: Call[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'hiring',
					grants: options.grants ?? GRANTS,
					expiresAt: Date.now() + 600_000,
				})
			}
			const call: Call = {
				url,
				method: init?.method ?? 'GET',
				body: init?.body ? JSON.parse(String(init.body)) : null,
			}
			calls.push(call)
			if (url.endsWith('/onboarding/templates')) {
				return Response.json({ templates: options.templates ?? [] })
			}
			if (url.endsWith('/tasks') && call.method === 'GET') {
				return Response.json({ tasks: options.tasks ?? [] })
			}
			if (call.method === 'PATCH' && options.patchError)
				return options.patchError
			if (call.method === 'POST' && options.postError) return options.postError
			if (url.endsWith('/apply')) {
				return Response.json({ tasks: [], created: 5 }, { status: 201 })
			}
			if (call.method === 'POST') {
				return Response.json({ task: task({ id: 'new' }) }, { status: 201 })
			}
			if (call.method === 'PATCH') {
				return Response.json({ task: task({ status: 'done' }) })
			}
			return Response.json({ ok: true })
		}),
	)
	return calls
}

function show(props: Partial<React.ComponentProps<typeof OnboardingTab>> = {}) {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<OnboardingTab
				staffId="s1"
				terminated={false}
				onChanged={() => {}}
				{...props}
			/>
		</StaffClientProvider>,
	)
}

describe('OnboardingTab', () => {
	it('shows progress and every task in order', async () => {
		stubApi({
			tasks: [
				task({ id: 'a', status: 'done', completedAt: Date.now() }),
				task({ id: 'b', title: 'Share the rules', dueDate: addDays(TODAY, 3) }),
				task({ id: 'c', taskKey: 'set_up_clock_pin', title: null }),
			],
		})
		show()
		expect(await screen.findByText('1 of 3 done')).toBeTruthy()
		const items = screen.getAllByRole('listitem')
		expect(items).toHaveLength(3)
		expect(within(items[1]!).getByText('Share the rules')).toBeTruthy()
		// A built-in task has no title of its own: it is worded in the viewer's language.
		expect(
			within(items[2]!).getByText('Set up their clock-in PIN'),
		).toBeTruthy()
		expect(
			screen.getByRole('progressbar', { name: 'Onboarding progress' }),
		).toBeTruthy()
	})

	it('says a task is late in words, not only colour', async () => {
		stubApi({
			tasks: [
				task({ dueDate: addDays(TODAY, -2) }),
				task({ id: 'x', dueDate: TODAY }),
			],
		})
		show()
		expect(await screen.findByText('Overdue by 2 days')).toBeTruthy()
		expect(screen.getByText('1 overdue')).toBeTruthy()
		expect(screen.getByText('Due today')).toBeTruthy()
	})

	it('opens a form link safely and reveals the policy text on request', async () => {
		stubApi({
			tasks: [
				task({
					id: 'f',
					type: 'form_link',
					title: 'Allergen form',
					linkUrl: 'https://forms.example.com/a',
				}),
				task({
					id: 'p',
					type: 'acknowledge_policy',
					title: 'Hygiene policy',
					instructions: 'Wash hands.\nWear a hat.',
				}),
			],
		})
		show()
		const link = await screen.findByRole('link', { name: /Open the form/ })
		expect(link.getAttribute('href')).toBe('https://forms.example.com/a')
		expect(link.getAttribute('target')).toBe('_blank')
		expect(link.getAttribute('rel')).toContain('noopener')
		expect(link.getAttribute('rel')).toContain('noreferrer')
		// The policy stays folded until someone asks to read it.
		expect(screen.queryByText(/Wear a hat/)).toBeNull()
		fireEvent.click(screen.getByRole('button', { name: 'Read the policy' }))
		expect(await screen.findByText(/Wear a hat/)).toBeTruthy()
	})

	it('never turns text from the server into markup', async () => {
		stubApi({
			tasks: [
				task({
					title: '<img src=x onerror=alert(1)>',
					type: 'acknowledge_policy',
					instructions: '<script>alert(1)</script>',
				}),
			],
		})
		const { container } = show()
		await screen.findByText('<img src=x onerror=alert(1)>')
		expect(container.querySelector('img')).toBeNull()
		expect(container.querySelector('script')).toBeNull()
	})

	it('marks a task done with one click and tells the roster', async () => {
		const calls = stubApi({ tasks: [task()] })
		const onChanged = vi.fn()
		show({ onChanged })
		const box = await screen.findByRole('checkbox', {
			name: 'Mark done: Confirm your details',
		})
		fireEvent.click(box)
		await waitFor(() =>
			expect(
				calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/tasks/t1')),
			).toMatchObject({ body: { status: 'done' } }),
		)
		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
	})

	it('explains a refusal in plain words', async () => {
		stubApi({
			tasks: [task()],
			patchError: Response.json({ error: 'Task not found' }, { status: 404 }),
		})
		show()
		fireEvent.click(
			await screen.findByRole('checkbox', {
				name: 'Mark done: Confirm your details',
			}),
		)
		expect(await screen.findByText(/We could not find that task/)).toBeTruthy()
	})

	it('is read-only without the update grant', async () => {
		stubApi({ tasks: [task()], grants: ['read:staff:any', 'read:hiring:any'] })
		show()
		const box = await screen.findByRole('checkbox', {
			name: 'Mark done: Confirm your details',
		})
		expect(
			(box as HTMLInputElement).disabled ||
				box.getAttribute('aria-disabled') === 'true' ||
				box.hasAttribute('data-disabled'),
		).toBe(true)
		expect(screen.queryByRole('button', { name: 'Add task' })).toBeNull()
		expect(screen.queryByRole('button', { name: /More actions/ })).toBeNull()
	})

	it('adds no tasks for someone who has left', async () => {
		stubApi({ tasks: [] })
		show({ terminated: true })
		expect(
			await screen.findByText(
				'This person has left, so there is no checklist.',
			),
		).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Add task' })).toBeNull()
	})

	it('checks the form before sending and then sends exactly what was typed', async () => {
		const calls = stubApi({ tasks: [task()] })
		show()
		fireEvent.click(await screen.findByRole('button', { name: 'Add task' }))
		const form = await screen.findByRole('form', { name: 'Add a task' })
		fireEvent.click(within(form).getByRole('button', { name: 'Add task' }))
		expect(await within(form).findByText('Name the task.')).toBeTruthy()
		expect(calls.some((c) => c.method === 'POST')).toBe(false)

		fireEvent.change(within(form).getByLabelText('Task'), {
			target: { value: 'Order uniform' },
		})
		fireEvent.click(within(form).getByRole('button', { name: 'Add task' }))
		await waitFor(() =>
			expect(calls.find((c) => c.method === 'POST')).toMatchObject({
				body: {
					type: 'custom',
					title: 'Order uniform',
					instructions: null,
					linkUrl: null,
					dueDate: null,
					assignee: 'manager',
				},
			}),
		)
	})

	it('offers the starter checklist when there are no tasks, and copies it', async () => {
		const calls = stubApi({ tasks: [] })
		show()
		expect(await screen.findByText('No onboarding tasks yet')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'Add a checklist…' }))
		expect(await screen.findByText('Starter checklist')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'Add checklist' }))
		await waitFor(() =>
			expect(calls.find((c) => c.url.endsWith('/apply'))).toMatchObject({
				method: 'POST',
				body: {},
			}),
		)
	})

	it('offers the default template first when there is one', async () => {
		const calls = stubApi({
			tasks: [],
			templates: [
				{
					id: 'tpl1',
					name: 'Floor start',
					isDefault: true,
					archivedAt: null,
					updatedAt: 1,
					tasks: [],
				},
			],
		})
		show()
		await screen.findByText('No onboarding tasks yet')
		fireEvent.click(screen.getByRole('button', { name: 'Add a checklist…' }))
		expect(await screen.findByText('Floor start')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'Add checklist' }))
		await waitFor(() =>
			expect(calls.find((c) => c.url.endsWith('/apply'))).toMatchObject({
				body: { templateId: 'tpl1' },
			}),
		)
	})

	it('shows a retry when the list cannot be loaded', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes('/staff/token')
					? Response.json({
							jwt: 'jwt',
							tenantApiUrl: 'https://us.tenant.test',
							scope: 'hiring',
							grants: GRANTS,
							expiresAt: Date.now() + 600_000,
						})
					: Response.json({ error: 'Staff member not found' }, { status: 404 }),
			),
		)
		show()
		expect(await screen.findByRole('alert')).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
	})
})
