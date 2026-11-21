import {
	GUEST_PHOTO_ALLOWED_MIME_TYPES,
	GUEST_PHOTO_CONSENT_TEXT,
	GUEST_PHOTO_MAX_BYTES,
} from '@repo/common/guest-photos'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { getAccessToken, tenantFetch } from '~/lib/client-auth'

export type GuestPhotoUploadLabels = {
	sharePrompt: string // "Share a photo of your {dish}"
	choosePhoto: string
	consentLabel: string
	submit: string
	uploading: string
	cancel: string
	submitted: string // "Thanks, the restaurant will review it"
	tooLarge: string
	invalidType: string
	heicUnavailable: string
	notEligible: string
	limitReached: string
	uploadFailed: string
}

export const DEFAULT_GUEST_PHOTO_LABELS: GuestPhotoUploadLabels = {
	sharePrompt: 'Share a photo of your {dish}',
	choosePhoto: 'Choose a photo (JPG, PNG, WebP, or HEIC, up to 10 MB)',
	consentLabel: GUEST_PHOTO_CONSENT_TEXT,
	submit: 'Submit photo',
	uploading: 'Uploading…',
	cancel: 'Cancel',
	submitted: 'Thanks, the restaurant will review it.',
	tooLarge: 'This photo is larger than 10 MB.',
	invalidType: 'Please choose a JPG, PNG, WebP, or HEIC image.',
	heicUnavailable:
		'This browser cannot convert HEIC photos. Please upload a JPG, PNG, or WebP photo.',
	notEligible:
		'Photos can only be shared for dishes you ordered within 14 days.',
	limitReached: 'You have reached the photo upload limit.',
	uploadFailed: 'We could not upload your photo. Please try again.',
}

export type EligibleDish = {
	itemId: string
	itemName: string
	submittedCount: number
	remainingForDish: number
	eligible: boolean
}

export type EligibilityPayload = {
	eligible: boolean
	orderId: string
	dailyRemaining: number
	dishes: EligibleDish[]
}

const ALLOWED_TYPES = new Set<string>(GUEST_PHOTO_ALLOWED_MIME_TYPES)
const MAX_EDGE = 1920

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	text?: string,
) {
	const node = document.createElement(tag)
	node.className = className
	if (text !== undefined) node.textContent = text
	return node
}

export async function preparePhotoFile(
	file: File,
): Promise<{ file: File; contentType: string }> {
	if (file.size <= 0 || file.size > GUEST_PHOTO_MAX_BYTES) {
		throw new Error('file_too_large')
	}
	const type = file.type.toLowerCase()
	if (type && !ALLOWED_TYPES.has(type)) {
		throw new Error('unsupported_image_type')
	}

	if (
		typeof createImageBitmap === 'function' &&
		typeof document !== 'undefined'
	) {
		try {
			const bitmap = await createImageBitmap(file)
			const scale = Math.min(
				1,
				MAX_EDGE / Math.max(bitmap.width, bitmap.height, 1),
			)
			const canvas = document.createElement('canvas')
			canvas.width = Math.max(1, Math.round(bitmap.width * scale))
			canvas.height = Math.max(1, Math.round(bitmap.height * scale))
			const ctx = canvas.getContext('2d')
			if (ctx) {
				ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
				bitmap.close()
				const blob = await new Promise<Blob | null>((resolve) =>
					canvas.toBlob((out) => resolve(out), 'image/jpeg', 0.88),
				)
				if (blob && blob.size > 0 && blob.size <= GUEST_PHOTO_MAX_BYTES) {
					return {
						file: new File([blob], 'dish-photo.jpg', { type: 'image/jpeg' }),
						contentType: 'image/jpeg',
					}
				}
			} else {
				bitmap.close()
			}
		} catch {
			// Fall back to original file for server validation/conversion.
		}
	}

	return {
		file,
		contentType: type || 'image/jpeg',
	}
}

export async function fetchOrderPhotoEligibility(
	orderId: string,
): Promise<EligibilityPayload | null> {
	if (!getAccessToken()) return null
	const { session, response } = await tenantFetch(
		`/photos/eligibility?${new URLSearchParams({ orderId })}`,
		{ cache: 'no-store' },
	)
	if (session !== 'ok' || !response.ok) return null
	const payload = (await response
		.json()
		.catch(() => null)) as EligibilityPayload | null
	if (!payload?.eligible || !Array.isArray(payload.dishes)) return null
	return payload
}

function errorMessageForCode(
	code: string | undefined,
	labels: GuestPhotoUploadLabels,
): string {
	switch (code) {
		case 'file_too_large':
			return labels.tooLarge
		case 'unsupported_image_type':
		case 'invalid_image_data':
			return labels.invalidType
		case 'heic_conversion_unavailable':
			return labels.heicUnavailable
		case 'not_eligible':
			return labels.notEligible
		case 'dish_order_limit_reached':
		case 'daily_limit_reached':
			return labels.limitReached
		default:
			return labels.uploadFailed
	}
}

export function renderDishPhotoShareList(
	container: HTMLElement,
	eligibility: EligibilityPayload,
	options: {
		labels: GuestPhotoUploadLabels
		locale: string
		defaultLocale: string
		uploadPhoto?: (input: {
			orderId: string
			itemId: string
			file: File
		}) => Promise<void>
	},
) {
	const eligibleDishes = eligibility.dishes.filter(
		(dish) => dish.eligible && dish.remainingForDish > 0,
	)
	if (eligibleDishes.length === 0) return false

	const wrapper = el(
		'div',
		'mt-3 space-y-2 border-t border-border pt-3 text-sm',
	)
	wrapper.dataset.guestPhotoShare = eligibility.orderId

	const uploadFn =
		options.uploadPhoto ??
		(async ({ orderId, itemId, file }) => {
			const prepared = await preparePhotoFile(file)
			if (!getAccessToken()) throw new Error('unauthorized')

			const formData = new FormData()
			formData.set('orderId', orderId)
			formData.set('itemId', itemId)
			formData.set('file', prepared.file)

			const { session: uploadSession, response: uploadRes } = await tenantFetch(
				'/photos/upload',
				{
					method: 'POST',
					body: formData,
				},
			)
			if (uploadSession !== 'ok') {
				throw new Error(
					uploadSession === 'signed_out' ? 'unauthorized' : 'upload_failed',
				)
			}
			const uploadBody = (await uploadRes.json().catch(() => null)) as {
				objectKey?: string
				contentType?: string
				byteSize?: number
				error?: string
			} | null
			if (!uploadRes.ok || !uploadBody?.objectKey) {
				throw new Error(uploadBody?.error ?? 'upload_failed')
			}

			const { session: submitSession, response: submitRes } = await tenantFetch(
				'/photos',
				{
					method: 'POST',
					body: JSON.stringify({
						orderId,
						itemId,
						objectKey: uploadBody.objectKey,
						contentType: uploadBody.contentType ?? prepared.contentType,
						byteSize: uploadBody.byteSize ?? prepared.file.size,
						consent: true,
						consentText: options.labels.consentLabel,
					}),
				},
			)
			if (submitSession !== 'ok' || !submitRes.ok) {
				const err = (await submitRes.json().catch(() => null)) as {
					error?: string
				} | null
				throw new Error(
					submitSession === 'signed_out'
						? 'unauthorized'
						: (err?.error ?? 'upload_failed'),
				)
			}
		})

	for (const dish of eligibleDishes) {
		const dishName =
			getLocalizedMenuValue(
				dish.itemName,
				options.locale,
				options.defaultLocale,
			) || dish.itemName
		const row = el('div', 'space-y-2')
		const formId =
			`guest-photo-form-${eligibility.orderId}-${dish.itemId}`.replace(
				/[^A-Za-z0-9_-]/g,
				'_',
			)
		const trigger = el(
			'button',
			'inline-flex min-h-9 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground hover:bg-muted/50',
			options.labels.sharePrompt.replace('{dish}', dishName),
		)
		trigger.type = 'button'
		trigger.dataset.shareDish = dish.itemId
		trigger.setAttribute('aria-expanded', 'false')
		trigger.setAttribute('aria-controls', formId)

		const form = el(
			'form',
			'hidden space-y-2 rounded-md border border-border p-3',
		)
		form.id = formId
		const fileLabel = el(
			'label',
			'block text-xs text-muted-foreground',
			options.labels.choosePhoto,
		)
		const fileInput = document.createElement('input')
		fileInput.type = 'file'
		fileInput.accept = GUEST_PHOTO_ALLOWED_MIME_TYPES.join(',')
		fileInput.required = true
		fileInput.className = 'mt-1 block w-full text-xs'
		fileLabel.appendChild(fileInput)

		const consentWrap = el(
			'label',
			'flex items-start gap-2 text-xs text-muted-foreground',
		)
		const consentBox = document.createElement('input')
		consentBox.type = 'checkbox'
		consentBox.required = true
		consentBox.className = 'mt-0.5'
		consentWrap.append(consentBox, el('span', '', options.labels.consentLabel))

		const statusEl = el('p', 'text-xs text-muted-foreground')
		statusEl.setAttribute('role', 'status')

		const actions = el('div', 'flex items-center gap-2')
		const submitBtn = el(
			'button',
			'inline-flex min-h-9 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50',
			options.labels.submit,
		)
		submitBtn.type = 'submit'
		const cancelBtn = el(
			'button',
			'inline-flex min-h-9 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground',
			options.labels.cancel,
		)
		cancelBtn.type = 'button'
		actions.append(submitBtn, cancelBtn)

		form.append(fileLabel, consentWrap, actions, statusEl)

		trigger.addEventListener('click', () => {
			const isOpen = !form.classList.toggle('hidden')
			trigger.setAttribute('aria-expanded', String(isOpen))
			if (isOpen) fileInput.focus()
		})
		cancelBtn.addEventListener('click', () => {
			form.classList.add('hidden')
			trigger.setAttribute('aria-expanded', 'false')
			trigger.focus()
		})
		form.addEventListener('submit', (event) => {
			event.preventDefault()
			const chosen = fileInput.files?.[0]
			if (!chosen || !consentBox.checked) return
			submitBtn.disabled = true
			submitBtn.textContent = options.labels.uploading
			statusEl.textContent = ''
			void uploadFn({
				orderId: eligibility.orderId,
				itemId: dish.itemId,
				file: chosen,
			})
				.then(() => {
					form.replaceChildren(
						el(
							'p',
							'text-xs font-medium text-foreground',
							options.labels.submitted,
						),
					)
					trigger.remove()
				})
				.catch((error: unknown) => {
					const code = error instanceof Error ? error.message : undefined
					statusEl.textContent = errorMessageForCode(code, options.labels)
					submitBtn.disabled = false
					submitBtn.textContent = options.labels.submit
				})
		})

		row.append(trigger, form)
		wrapper.appendChild(row)
	}

	container.appendChild(wrapper)
	return true
}

function parseLabels(raw: string | undefined): GuestPhotoUploadLabels {
	if (!raw) return DEFAULT_GUEST_PHOTO_LABELS
	try {
		return {
			...DEFAULT_GUEST_PHOTO_LABELS,
			...(JSON.parse(raw) as Partial<GuestPhotoUploadLabels>),
		}
	} catch {
		return DEFAULT_GUEST_PHOTO_LABELS
	}
}

export function initProfileOrderPhotoUploads(root: HTMLElement) {
	if (!getAccessToken()) return
	const list = root.querySelector<HTMLElement>('[data-restaurant-orders-list]')
	if (!list) return
	const labels = parseLabels(root.dataset.photoLabels)
	const locale = root.dataset.locale || 'en'
	const defaultLocale = root.dataset.defaultLocale || 'en'
	const seen = new Set<string>()

	const attachRow = (li: HTMLElement) => {
		const orderId = li.dataset.orderId
		if (!orderId || seen.has(orderId)) return
		seen.add(orderId)
		void fetchOrderPhotoEligibility(orderId).then((eligibility) => {
			if (!eligibility) return
			renderDishPhotoShareList(li, eligibility, {
				labels,
				locale,
				defaultLocale,
			})
		})
	}

	for (const li of list.querySelectorAll<HTMLElement>('li[data-order-id]')) {
		attachRow(li)
	}

	const observer = new MutationObserver(() => {
		for (const li of list.querySelectorAll<HTMLElement>('li[data-order-id]')) {
			attachRow(li)
		}
	})
	observer.observe(list, { childList: true })
}

export function initSuccessPagePhotoUploads(section: HTMLElement) {
	if (!getAccessToken()) return
	const orderId = new URLSearchParams(window.location.search).get('order')
	if (!orderId) return
	const labels = parseLabels(section.dataset.photoLabels)
	const locale = section.dataset.locale || 'en'
	const defaultLocale = section.dataset.defaultLocale || 'en'

	void fetchOrderPhotoEligibility(orderId).then((eligibility) => {
		if (!eligibility) return
		const rendered = renderDishPhotoShareList(section, eligibility, {
			labels,
			locale,
			defaultLocale,
		})
		if (rendered) section.classList.remove('hidden')
	})
}

if (typeof document !== 'undefined') {
	const ordersRoot = document.getElementById('restaurant-orders-root')
	if (ordersRoot) initProfileOrderPhotoUploads(ordersRoot)
	const successRoot = document.getElementById('guest-photo-share')
	if (successRoot) initSuccessPagePhotoUploads(successRoot)
}
