/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/client-auth', () => ({
	getAccessToken: vi.fn(() => 'tok_123'),
	getBrowserTenantApiUrl: vi.fn(() => 'https://api.example.test'),
	tenantFetch: vi.fn(),
}))

import {
	DEFAULT_GUEST_PHOTO_LABELS,
	renderDishPhotoShareList,
} from './guest-photo-upload'

describe('guest-photo-upload script (#148)', () => {
	beforeEach(() => {
		document.body.innerHTML = ''
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

		trigger.click()
		const form = container.querySelector('form')!
		expect(form.classList.contains('hidden')).toBe(false)

		const fileInput =
			form.querySelector<HTMLInputElement>('input[type="file"]')!
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
})
