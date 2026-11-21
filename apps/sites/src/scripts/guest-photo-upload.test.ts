/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/client-auth', () => ({
	getAccessToken: vi.fn(() => 'tok_123'),
	tenantFetch: vi.fn(),
}))

import {
	DEFAULT_GUEST_PHOTO_LABELS,
	renderDishPhotoShareList,
} from './guest-photo-upload'
import { tenantFetch } from '~/lib/client-auth'

describe('guest-photo-upload script (#148)', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
		vi.mocked(tenantFetch).mockReset()
	})

	it('renders "Share a photo of your <dish>" and submits consent + file with confirmation message', async () => {
		const container = document.createElement('div')
		document.body.appendChild(container)
		const uploadSpy = vi.fn(async () => {})

		const rendered = renderDishPhotoShareList(
			container,
			{
				eligible: true,
				orderId: 'ord_1',
				dailyRemaining: 10,
				dishes: [
					{
						itemId: 'item_1',
						itemName: 'Margherita',
						submittedCount: 0,
						remainingForDish: 3,
						eligible: true,
					},
				],
			},
			{
				labels: DEFAULT_GUEST_PHOTO_LABELS,
				locale: 'en',
				defaultLocale: 'en',
				uploadPhoto: uploadSpy,
			},
		)

		expect(rendered).toBe(true)
		const trigger = container.querySelector<HTMLButtonElement>(
			'button[data-share-dish="item_1"]',
		)!
		expect(trigger.textContent).toBe('Share a photo of your Margherita')
		expect(trigger.getAttribute('aria-expanded')).toBe('false')
		const form = container.querySelector('form')!
		expect(trigger.getAttribute('aria-controls')).toBe(form.id)
		expect(form.id).toBeTruthy()

		trigger.click()
		expect(form.classList.contains('hidden')).toBe(false)
		expect(trigger.getAttribute('aria-expanded')).toBe('true')

		const fileInput =
			form.querySelector<HTMLInputElement>('input[type="file"]')!
		expect(fileInput.matches(':focus')).toBe(true)

		const cancelBtn = form.querySelector<HTMLButtonElement>(
			'button[type="button"]',
		)!
		cancelBtn.click()
		expect(form.classList.contains('hidden')).toBe(true)
		expect(trigger.getAttribute('aria-expanded')).toBe('false')
		expect(trigger.matches(':focus')).toBe(true)

		trigger.click()
		expect(trigger.getAttribute('aria-expanded')).toBe('true')
		const consentBox = form.querySelector<HTMLInputElement>(
			'input[type="checkbox"]',
		)!
		const file = new File(
			[new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
			'pie.jpg',
			{
				type: 'image/jpeg',
			},
		)
		Object.defineProperty(fileInput, 'files', { value: [file] })
		consentBox.checked = true

		form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

		await vi.waitFor(() => {
			expect(uploadSpy).toHaveBeenCalledWith({
				orderId: 'ord_1',
				itemId: 'item_1',
				file,
			})
			expect(container.textContent).toContain(
				'Thanks, the restaurant will review it.',
			)
		})
	})

	it('renders nothing when no dishes have remaining eligibility', () => {
		const container = document.createElement('div')
		const rendered = renderDishPhotoShareList(
			container,
			{
				eligible: true,
				orderId: 'ord_1',
				dailyRemaining: 0,
				dishes: [
					{
						itemId: 'item_1',
						itemName: 'Margherita',
						submittedCount: 3,
						remainingForDish: 0,
						eligible: false,
					},
				],
			},
			{
				labels: DEFAULT_GUEST_PHOTO_LABELS,
				locale: 'en',
				defaultLocale: 'en',
			},
		)
		expect(rendered).toBe(false)
		expect(container.children).toHaveLength(0)
	})

	it('uploads and submits via tenantFetch so expired access tokens refresh automatically', async () => {
		const container = document.createElement('div')
		document.body.appendChild(container)
		const rawFetch = vi.fn()
		vi.stubGlobal('fetch', rawFetch)
		vi.mocked(tenantFetch)
			.mockResolvedValueOnce({
				session: 'ok',
				response: Response.json({
					objectKey: 'guest-photos/org_1/photo.jpg',
					contentType: 'image/jpeg',
					byteSize: 4,
				}),
			})
			.mockResolvedValueOnce({
				session: 'ok',
				response: Response.json({ ok: true }),
			})

		renderDishPhotoShareList(
			container,
			{
				eligible: true,
				orderId: 'ord_refresh',
				dailyRemaining: 10,
				dishes: [
					{
						itemId: 'item_2',
						itemName: 'Tiramisu',
						submittedCount: 0,
						remainingForDish: 3,
						eligible: true,
					},
				],
			},
			{
				labels: DEFAULT_GUEST_PHOTO_LABELS,
				locale: 'en',
				defaultLocale: 'en',
			},
		)

		const trigger = container.querySelector<HTMLButtonElement>(
			'button[data-share-dish="item_2"]',
		)!
		trigger.click()
		const form = container.querySelector('form')!
		const fileInput =
			form.querySelector<HTMLInputElement>('input[type="file"]')!
		const consentBox = form.querySelector<HTMLInputElement>(
			'input[type="checkbox"]',
		)!
		const file = new File(
			[new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
			'tiramisu.jpg',
			{ type: 'image/jpeg' },
		)
		Object.defineProperty(fileInput, 'files', { value: [file] })
		consentBox.checked = true

		form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

		await vi.waitFor(() => {
			expect(tenantFetch).toHaveBeenCalledTimes(2)
		})
		expect(rawFetch).not.toHaveBeenCalled()
		expect(tenantFetch).toHaveBeenNthCalledWith(
			1,
			'/photos/upload',
			expect.objectContaining({
				method: 'POST',
				body: expect.any(FormData),
			}),
		)
		expect(tenantFetch).toHaveBeenNthCalledWith(
			2,
			'/photos',
			expect.objectContaining({
				method: 'POST',
			}),
		)
		vi.unstubAllGlobals()
	})
})
