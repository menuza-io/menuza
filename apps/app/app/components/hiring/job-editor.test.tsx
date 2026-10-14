// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type PostingDetail } from '#app/utils/hiring/job-posting-types.ts'
import { JobEditor } from './job-editor.tsx'

// ProseMirror needs layout APIs jsdom lacks; the editor is covered on its own
// by the server-side sanitizer tests and in the browser.
vi.mock('./description-editor.tsx', () => ({
	DescriptionEditor: ({
		value,
		onChange,
		labelId,
	}: {
		value: string
		onChange: (html: string) => void
		labelId: string
	}) => (
		<textarea
			aria-labelledby={labelId}
			value={value}
			onChange={(event) => onChange(event.target.value)}
		/>
	),
}))
vi.mock('./job-share-panel.tsx', () => ({
	JobSharePanel: ({ url }: { url: string }) => <p>share:{url}</p>,
}))

const locations = [
	{ id: 'loc1', name: 'Downtown', currency: 'USD' },
	{ id: 'loc2', name: 'Airport', currency: 'USD' },
]

const posting: PostingDetail = {
	id: 'p1',
	slug: 'line-cook',
	title: 'Line cook',
	positionName: 'Cook',
	status: 'draft',
	employmentType: 'full_time',
	isGeneral: false,
	payType: 'none',
	payMinMinor: null,
	payMaxMinor: null,
	currency: 'USD',
	locationIds: [],
	locationNames: [],
	publishedAt: null,
	expiresAt: null,
	updatedAt: '2026-10-13T00:00:00.000Z',
	descriptionHtml: '<p>Cook on the line during busy dinner service.</p>',
	questions: [],
	translations: {},
	closesOn: null,
}

type Submit = { intent: string; payload: any }
function renderEditor(
	props: Partial<React.ComponentProps<typeof JobEditor>> = {},
	reply: (submit: Submit) => unknown = (submit) => ({
		ok: true,
		intent: submit.intent,
		posting: {
			...posting,
			title: submit.payload?.title ?? posting.title,
			status: submit.intent === 'publish' ? 'published' : 'draft',
		},
	}),
) {
	i18n.load('en', {})
	i18n.activate('en')
	const submits: Submit[] = []
	const router = createMemoryRouter(
		[
			{
				path: '/acme/staff/hiring/new',
				element: (
					<JobEditor
						orgSlug="acme"
						posting={null}
						locations={locations}
						defaultCurrency="USD"
						siteOrigin="https://acme.example"
						sitePublished
						initialStep="role"
						defaultLocale="en"
						supportedLocales={['en']}
						canPostEverywhere
						{...props}
					/>
				),
				action: async ({ request }) => {
					const form = await request.formData()
					const submit = {
						intent: String(form.get('intent')),
						payload: form.get('payload')
							? JSON.parse(String(form.get('payload')))
							: null,
					}
					submits.push(submit)
					return reply(submit)
				},
			},
		],
		{ initialEntries: ['/acme/staff/hiring/new'] },
	)
	render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
	return { submits, router }
}

afterEach(() => vi.restoreAllMocks())

describe('JobEditor', () => {
	it('starts on the role step and will not move on without a title and position', async () => {
		renderEditor()
		expect(
			screen.getByRole('heading', { name: 'What is the job?' }),
		).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: /^Next/ }))
		expect(await screen.findByText('Give the job a title.')).toBeTruthy()
		expect(screen.getByText('Say which position this is.')).toBeTruthy()
		expect(
			screen.getByRole('heading', { name: 'What is the job?' }),
		).toBeTruthy()
	})

	it('marks the current step and walks through all four', async () => {
		renderEditor()
		fireEvent.change(screen.getByLabelText('Job title'), {
			target: { value: 'Line cook' },
		})
		fireEvent.change(screen.getByLabelText('Position'), {
			target: { value: 'Cook' },
		})
		const next = () =>
			fireEvent.click(screen.getByRole('button', { name: /^Next/ }))
		next()
		expect(
			await screen.findByRole('heading', { name: 'What does it pay?' }),
		).toBeTruthy()
		const steps = screen.getByRole('tablist', { name: 'Steps' })
		expect(
			within(steps)
				.getByRole('tab', { name: 'Pay' })
				.getAttribute('aria-selected'),
		).toBe('true')
		next()
		expect(
			await screen.findByRole('heading', { name: 'What do you want to ask?' }),
		).toBeTruthy()
		next()
		expect(
			await screen.findByRole('heading', { name: 'Check it over' }),
		).toBeTruthy()
	})

	it('asks for pay figures only when pay is shown, and checks them', async () => {
		renderEditor({
			posting: { ...posting, payType: 'hourly', payMinMinor: null },
		})
		fireEvent.click(screen.getByRole('tab', { name: 'Pay' }))
		fireEvent.click(screen.getByRole('button', { name: /^Next/ }))
		expect(
			await screen.findByText('Enter a pay amount, or choose not to show pay.'),
		).toBeTruthy()
		fireEvent.change(screen.getByLabelText('From'), { target: { value: '25' } })
		fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '15' } })
		fireEvent.click(screen.getByRole('button', { name: /^Next/ }))
		expect(
			await screen.findByText(
				'The top of the range must be at least the bottom.',
			),
		).toBeTruthy()
	})

	it('lists what blocks publishing and jumps to the step that fixes it', async () => {
		renderEditor({ posting: { ...posting, descriptionHtml: '' } })
		fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
		const blocker = await screen.findByRole('button', {
			name: /Write a description/,
		})
		fireEvent.click(blocker)
		expect(
			await screen.findByRole('heading', { name: 'What is the job?' }),
		).toBeTruthy()
	})

	it('saves a new draft with money as minor units and no pay when hidden', async () => {
		const { submits } = renderEditor({})
		fireEvent.change(screen.getByLabelText('Job title'), {
			target: { value: 'Line cook' },
		})
		fireEvent.change(screen.getByLabelText('Position'), {
			target: { value: 'Cook' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
		await waitFor(() => expect(submits).toHaveLength(1))
		expect(submits[0]).toMatchObject({
			intent: 'save',
			payload: {
				title: 'Line cook',
				payType: 'none',
				payMinMinor: null,
				employmentType: 'part_time',
				locationIds: [],
			},
		})
	})

	it('publishes from the review step only', async () => {
		const { submits } = renderEditor({ posting })
		expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
		fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
		fireEvent.click(await screen.findByRole('button', { name: 'Publish' }))
		await waitFor(() => expect(submits[0]?.intent).toBe('publish'))
	})

	it('shows the share link and QR panel only for a live job', async () => {
		renderEditor({
			posting: { ...posting, status: 'published' },
			initialStep: 'review',
		})
		expect(
			await screen.findByText('share:https://acme.example/careers/line-cook'),
		).toBeTruthy()
		expect(screen.getByRole('button', { name: 'Close this job' })).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
	})

	it('hides sharing and offers delete for a draft', async () => {
		renderEditor({ posting, initialStep: 'review' })
		expect(
			await screen.findByRole('button', { name: 'Delete this job' }),
		).toBeTruthy()
		expect(screen.queryByText(/share:/)).toBeNull()
	})

	it('warns when a live job’s site is not published', async () => {
		renderEditor({
			posting: { ...posting, status: 'published' },
			initialStep: 'review',
			sitePublished: false,
		})
		expect(await screen.findByText(/website is not published yet/)).toBeTruthy()
	})

	it('adds, edits and removes screener questions', async () => {
		renderEditor({ posting, initialStep: 'screener' })
		fireEvent.click(screen.getByRole('button', { name: 'Yes or no question' }))
		fireEvent.change(
			screen.getByLabelText('Yes or no question', { selector: 'input' }),
			{
				target: { value: 'Can you work weekends?' },
			},
		)
		fireEvent.click(screen.getByRole('switch', { name: 'Dealbreaker' }))
		expect(await screen.findByText('The right answer is')).toBeTruthy()
		fireEvent.click(screen.getByRole('button', { name: 'Remove question 1' }))
		expect(screen.queryByDisplayValue('Can you work weekends?')).toBeNull()
	})

	it('stops adding questions at the limit', async () => {
		const questions = Array.from({ length: 10 }, (ignored, index) => ({
			id: `q${index}`,
			kind: 'open' as const,
			prompt: `Question ${index}`,
			required: false,
			maxLength: 500,
		}))
		renderEditor({
			posting: { ...posting, questions },
			initialStep: 'screener',
		})
		expect(
			screen
				.getByRole('button', { name: 'Open question' })
				.hasAttribute('disabled'),
		).toBe(true)
	})

	it('shows a plain message when the server refuses', async () => {
		renderEditor({ posting }, () => ({
			ok: false,
			intent: 'save',
			error: 'not_found',
		}))
		fireEvent.change(screen.getByLabelText('Job title'), {
			target: { value: 'Head chef' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
		expect(
			await screen.findByText(
				'This job no longer exists. Go back to the list.',
			),
		).toBeTruthy()
	})

	it('fills the form from an AI draft and can undo it', async () => {
		renderEditor({}, (submit) =>
			submit.intent === 'ai_draft'
				? {
						ok: true,
						intent: 'ai_draft',
						draft: {
							title: 'Evening line cook',
							positionName: 'Line cook',
							employmentType: 'part_time',
							descriptionHtml: '<p>Cook with us three nights a week.</p>',
							questions: [],
						},
					}
				: { ok: true, intent: 'save', posting },
		)
		fireEvent.change(screen.getByLabelText('Start from a few words'), {
			target: { value: 'evening cook' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Write a draft' }))
		await waitFor(() =>
			expect(
				(screen.getByLabelText('Job title') as HTMLInputElement).value,
			).toBe('Evening line cook'),
		)
		fireEvent.click(screen.getByRole('button', { name: 'Undo draft' }))
		expect((screen.getByLabelText('Job title') as HTMLInputElement).value).toBe(
			'',
		)
	})

	it('writes other languages into translations and keeps the default copy', async () => {
		const { submits } = renderEditor({
			posting,
			supportedLocales: ['en', 'ar'],
		})
		const title = () => screen.getByLabelText('Job title') as HTMLInputElement
		expect(title().value).toBe('Line cook')

		fireEvent.click(screen.getByText('ar'))
		expect(
			await screen.findByText(/version\. Anything you leave blank/),
		).toBeTruthy()
		// The Arabic title starts empty and shows the default as its placeholder.
		expect(title().value).toBe('')
		expect(title().placeholder).toBe('Line cook')
		// Fields that are not translated are not offered.
		expect(screen.queryByLabelText('Position')).toBeNull()

		fireEvent.change(title(), { target: { value: 'طباخ' } })
		fireEvent.click(screen.getByText('en'))
		expect(title().value).toBe('Line cook')

		fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
		await waitFor(() => expect(submits).toHaveLength(1))
		expect(submits[0]?.payload.title).toBe('Line cook')
		expect(submits[0]?.payload.translations).toEqual({ ar: { title: 'طباخ' } })
	})

	it('offers no language switcher for a one-language site', () => {
		renderEditor({ posting })
		expect(
			screen.queryByRole('radiogroup', { name: 'Content language' }),
		).toBeNull()
	})

	it('lets a job be at several locations, and asks for at least one', async () => {
		const { submits } = renderEditor({
			posting: { ...posting, locationIds: [], locationNames: [] },
		})
		// Open everywhere by default; the checklist appears for "Selected".
		expect(screen.queryByRole('checkbox', { name: 'Downtown' })).toBeNull()
		fireEvent.click(screen.getByRole('radio', { name: /Selected locations/ }))
		fireEvent.click(screen.getByRole('button', { name: /^Next/ }))
		expect(
			await screen.findByText('Choose at least one location.'),
		).toBeTruthy()

		fireEvent.click(screen.getByRole('checkbox', { name: 'Downtown' }))
		fireEvent.click(screen.getByRole('checkbox', { name: 'Airport' }))
		fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
		await waitFor(() => expect(submits).toHaveLength(1))
		expect(submits[0]?.payload.locationIds).toEqual(['loc1', 'loc2'])
	})

	it('hides the location choice when the business has one location', () => {
		renderEditor({ posting, locations: [locations[0]!] })
		expect(
			screen.queryByRole('radio', { name: /Selected locations/ }),
		).toBeNull()
	})

	it('offers a limited member only their own locations', () => {
		renderEditor({ posting, canPostEverywhere: false })
		expect(screen.queryByRole('radio', { name: /All locations/ })).toBeNull()
		expect(screen.getByRole('checkbox', { name: 'Downtown' })).toBeTruthy()
	})

	it('shows no location choice or "where" row for a business without locations', async () => {
		renderEditor({ posting, locations: [] })
		expect(
			screen.queryByRole('radio', { name: /Selected locations/ }),
		).toBeNull()
		fireEvent.click(screen.getByRole('tab', { name: /Review/ }))
		expect(screen.queryByText('Where')).toBeNull()
	})
})
