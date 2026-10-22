// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoteCard, type Note } from './notes-cards.tsx'

const note: Note = {
	id: 'note_1',
	title: 'Opening checklist',
	content: 'Unlock the doors',
	createdAt: '2026-10-01T09:00:00.000Z',
	updatedAt: '2026-10-01T09:00:00.000Z',
	createdByName: 'Ada Lovelace',
	uploads: [],
}

function renderCard() {
	i18n.load('en', {})
	i18n.activate('en')
	const router = createMemoryRouter(
		[
			{
				path: '/acme/notes',
				element: <NoteCard note={note} organizationId="org_1" />,
			},
		],
		{ initialEntries: ['/acme/notes'] },
	)
	return render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

afterEach(() => {
	cleanup()
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe('NoteCard copy link', () => {
	it('says the link was copied once the clipboard write succeeds', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		vi.stubGlobal('navigator', { clipboard: { writeText } })
		renderCard()
		fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
		expect(
			await screen.findByRole('button', { name: 'Link copied!' }),
		).toBeTruthy()
		expect(screen.getByRole('status')).toHaveTextContent('Link copied!')
		expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/note_1$/))
	})

	it('does not claim success when the browser denies the clipboard write', async () => {
		vi.stubGlobal('navigator', {
			clipboard: {
				writeText: vi
					.fn()
					.mockRejectedValue(
						new DOMException('Write permission denied.', 'NotAllowedError'),
					),
			},
		})
		renderCard()
		fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
		expect(
			await screen.findByRole('button', { name: "Couldn't copy link" }),
		).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Link copied!' })).toBeNull()
		expect(screen.getByRole('status')).toHaveTextContent("Couldn't copy link")
	})

	it('keeps the feedback for two seconds after the latest click', async () => {
		vi.useFakeTimers()
		vi.stubGlobal('navigator', {
			clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
		})
		renderCard()
		fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
		// Settle the clipboard write now, so the reset timer starts at 0 ms.
		await act(() => vi.advanceTimersByTimeAsync(0))
		await act(() => vi.advanceTimersByTimeAsync(1500))
		fireEvent.click(screen.getByRole('button', { name: 'Link copied!' }))
		await act(() => vi.advanceTimersByTimeAsync(0))
		await act(() => vi.advanceTimersByTimeAsync(1000))
		expect(screen.getByRole('button', { name: 'Link copied!' })).toBeTruthy()
		await act(() => vi.advanceTimersByTimeAsync(1000))
		expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
	})

	it('ignores an older write that settles after a newer one', async () => {
		let failFirstWrite: (error: unknown) => void = () => {}
		const writeText = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise((_, reject) => {
						failFirstWrite = reject
					}),
			)
			.mockResolvedValueOnce(undefined)
		vi.stubGlobal('navigator', { clipboard: { writeText } })
		renderCard()
		const button = screen.getByRole('button', { name: 'Copy link' })
		fireEvent.click(button)
		fireEvent.click(button)
		expect(
			await screen.findByRole('button', { name: 'Link copied!' }),
		).toBeTruthy()
		await act(async () => {
			failFirstWrite(
				new DOMException('Document is not focused.', 'NotAllowedError'),
			)
		})
		expect(screen.getByRole('button', { name: 'Link copied!' })).toBeTruthy()
		expect(screen.getByRole('status')).toHaveTextContent('Link copied!')
	})
})
