// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { renderStaff } from '#tests/staff-render.tsx'
import { OnboardingTemplatesPage } from './templates-page.tsx'

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

type Call = { url: string; method: string; body: any }

const template = (over: Record<string, unknown> = {}) => ({
	id: 'tpl1',
	name: 'Floor start',
	isDefault: true,
	archivedAt: null,
	updatedAt: 1,
	tasks: [
		{
			id: 'a',
			type: 'review_profile',
			title: 'Confirm your details',
			instructions: null,
			linkUrl: null,
			dueInDays: 0,
			assignee: 'manager',
			assigneeUserId: null,
			sortOrder: 0,
		},
		{
			id: 'b',
			type: 'custom',
			title: 'Meet the chef',
			instructions: null,
			linkUrl: null,
			dueInDays: 2,
			assignee: 'staff',
			assigneeUserId: null,
			sortOrder: 1,
		},
	],
	...over,
})

function stubApi(templates: unknown[] = []) {
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
					grants: ['read:hiring:any', 'update:hiring:any'],
					expiresAt: Date.now() + 600_000,
				})
			}
			const call: Call = {
				url,
				method: init?.method ?? 'GET',
				body: init?.body ? JSON.parse(String(init.body)) : null,
			}
			calls.push(call)
			if (call.method === 'GET') return Response.json({ templates })
			if (call.method === 'DELETE') return Response.json({ archived: true })
			return Response.json({ template: template() }, { status: 201 })
		}),
	)
	return calls
}

const show = (canWrite = true) =>
	renderStaff(
		<StaffClientProvider orgSlug="acme">
			<OnboardingTemplatesPage canWrite={canWrite} />
		</StaffClientProvider>,
	)

describe('OnboardingTemplatesPage', () => {
	it('explains the starter checklist when there are no templates', async () => {
		stubApi([])
		show()
		expect(
			await screen.findByText('New hires get a starter checklist'),
		).toBeTruthy()
		expect(
			screen.getByRole('button', { name: 'Start from the starter list' }),
		).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Start blank' })).toBeTruthy()
	})

	it('starts from the five starter tasks, as the default, and saves them in order', async () => {
		const calls = stubApi([])
		show()
		fireEvent.click(
			await screen.findByRole('button', {
				name: 'Start from the starter list',
			}),
		)
		const sheet = await screen.findByRole('dialog')
		expect(within(sheet).getByText('5 tasks')).toBeTruthy()
		expect(
			within(sheet)
				.getByRole('switch', { name: 'Add to new hires automatically' })
				.getAttribute('aria-checked'),
		).toBe('true')
		fireEvent.change(within(sheet).getByLabelText('Template name'), {
			target: { value: 'Starter' },
		})
		fireEvent.click(
			within(sheet).getByRole('button', { name: 'Save template' }),
		)
		await waitFor(() => {
			const post = calls.find((c) => c.method === 'POST')
			expect(post?.url).toMatch(/\/onboarding\/templates$/)
			expect(post?.body.name).toBe('Starter')
			expect(post?.body.isDefault).toBe(true)
			expect(post?.body.tasks.map((t: { title: string }) => t.title)).toEqual([
				'Confirm contact details',
				'Add an emergency contact',
				'Share the house rules',
				'Set up their clock-in PIN',
				'Add them to the schedule',
			])
			expect(post?.body.tasks[0]).toMatchObject({
				type: 'review_profile',
				dueInDays: 0,
			})
			expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2)
		})
	})

	it('refuses to save a nameless template and points at the problem', async () => {
		const calls = stubApi([])
		show()
		fireEvent.click(await screen.findByRole('button', { name: 'Start blank' }))
		const sheet = await screen.findByRole('dialog')
		fireEvent.click(
			within(sheet).getByRole('button', { name: 'Save template' }),
		)
		expect(
			await within(sheet).findByText('Give the template a name.'),
		).toBeTruthy()
		expect(within(sheet).getByText('Name the task.')).toBeTruthy()
		expect(calls.some((c) => c.method === 'POST')).toBe(false)
	})

	it('reorders and removes tasks with buttons', async () => {
		const calls = stubApi([template()])
		show()
		fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
		const sheet = await screen.findByRole('dialog')
		// The first task cannot move up; the last cannot move down.
		expect(
			within(sheet).getByRole('button', { name: 'Move task 1 up' }),
		).toBeDisabled()
		expect(
			within(sheet).getByRole('button', { name: 'Move task 2 down' }),
		).toBeDisabled()
		fireEvent.click(
			within(sheet).getByRole('button', { name: 'Move task 2 up' }),
		)
		fireEvent.click(
			within(sheet).getByRole('button', { name: 'Save template' }),
		)
		await waitFor(() => {
			const put = calls.find((c) => c.method === 'PUT')
			expect(put?.url).toMatch(/\/onboarding\/templates\/tpl1$/)
			expect(put?.body.tasks.map((t: { title: string }) => t.title)).toEqual([
				'Meet the chef',
				'Confirm your details',
			])
			// What was already set is kept.
			expect(put?.body.tasks[0]).toMatchObject({
				assignee: 'staff',
				dueInDays: 2,
			})
		})
	})

	it('shows only the fields a task kind needs', async () => {
		stubApi([
			template({
				tasks: [
					{
						id: 'f',
						type: 'form_link',
						title: 'Allergen form',
						instructions: null,
						linkUrl: 'https://forms.example.com/a',
						dueInDays: 1,
						assignee: 'staff',
						assigneeUserId: null,
						sortOrder: 0,
					},
					{
						id: 'p',
						type: 'acknowledge_policy',
						title: 'Hygiene policy',
						instructions: 'Wash hands.',
						linkUrl: null,
						dueInDays: 1,
						assignee: 'manager',
						assigneeUserId: null,
						sortOrder: 1,
					},
					{
						id: 'c',
						type: 'custom',
						title: 'Hand in rota',
						instructions: null,
						linkUrl: null,
						dueInDays: 1,
						assignee: 'manager',
						assigneeUserId: null,
						sortOrder: 2,
					},
				],
			}),
		])
		show()
		fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
		const sheet = await screen.findByRole('dialog')
		// One link field (the form task), one policy field (the policy task).
		expect(within(sheet).getAllByLabelText('Link to the form')).toHaveLength(1)
		expect(
			(within(sheet).getByLabelText('Link to the form') as HTMLInputElement)
				.value,
		).toBe('https://forms.example.com/a')
		expect(within(sheet).getAllByLabelText('Policy')).toHaveLength(1)
		// No ID, bank or tax field exists anywhere in the builder.
		expect(sheet.textContent).toMatch(
			/Do not ask for ID numbers, bank details or tax forms/,
		)
		expect(sheet.querySelector('input[type="file"]')).toBeNull()
	})

	it('confirms before removing a template', async () => {
		const calls = stubApi([template()])
		show()
		fireEvent.click(
			await screen.findByRole('button', {
				name: 'Remove template Floor start',
			}),
		)
		expect(await screen.findByText('Remove this template?')).toBeTruthy()
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
		fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
		await waitFor(() =>
			expect(calls.find((c) => c.method === 'DELETE')?.url).toMatch(
				/\/onboarding\/templates\/tpl1$/,
			),
		)
	})

	it('lists templates read-only without write access', async () => {
		stubApi([template()])
		show(false)
		expect(await screen.findByText('Floor start')).toBeTruthy()
		expect(screen.getByText('Added to new hires')).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'New template' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
		expect(screen.getByText(/needs permission to update hiring/)).toBeTruthy()
	})
})
