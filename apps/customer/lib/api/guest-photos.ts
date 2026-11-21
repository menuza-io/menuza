import {
	GUEST_PHOTO_CONSENT_TEXT,
	guestPhotoMimeTypeSchema,
	guestPhotoSubmissionSchema,
	type GuestPhotoMimeType,
	type GuestPhotoSubmission,
} from '@repo/common/guest-photos'
import { fetch } from 'expo/fetch'
import { z } from 'zod'
import { type CustomerSession } from '../session/customer-session'
import { ApiError } from './api-error'
import { buildUrl, decodeResponse, performRequest } from './request'

const eligibleDishSchema = z.object({
	itemId: z.string(),
	itemName: z.string(),
	submittedCount: z.number(),
	remainingForDish: z.number(),
	eligible: z.boolean(),
})

const eligibilitySchema = z.object({
	eligible: z.boolean(),
	orderId: z.string(),
	orderCreatedAt: z.string(),
	windowDays: z.number(),
	maxPerDishOrder: z.number(),
	maxPerGuestDay: z.number(),
	dailyUsed: z.number(),
	dailyRemaining: z.number(),
	dishes: z.array(eligibleDishSchema),
})

const uploadResultSchema = z.object({
	objectKey: z.string(),
	contentType: guestPhotoMimeTypeSchema,
	byteSize: z.number().int().positive(),
})

const submitResponseSchema = z.object({
	submission: guestPhotoSubmissionSchema,
})

export type EligibleGuestPhotoDish = z.infer<typeof eligibleDishSchema>
export type GuestPhotoEligibility = z.infer<typeof eligibilitySchema>
export type GuestPhotoUploadResult = z.infer<typeof uploadResultSchema>

export type GuestPhotoFileInput =
	| { uri: string; name: string; type: string }
	| { blob: Blob; name: string; type: string }

export type MultipartUploadTransport = (input: {
	url: string
	headers: Record<string, string>
	body: FormData
	timeoutMs: number
}) => Promise<{ status: number; body: string }>

const defaultMultipartTransport: MultipartUploadTransport = async (input) => {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), input.timeoutMs)
	try {
		const response = await fetch(input.url, {
			method: 'POST',
			headers: input.headers,
			body: input.body as unknown as BodyInit,
			credentials: 'omit',
			redirect: 'manual',
			signal: controller.signal,
		})
		return {
			status: response.status,
			body: await response.text(),
		}
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Customer guest dish photos client (#148): calls the regional tenant-api
 * `/photos/*` routes directly with the customer's bearer token.
 */
export class GuestPhotosClient {
	readonly #session: CustomerSession
	readonly #uploadTransport: MultipartUploadTransport

	constructor(
		session: CustomerSession,
		uploadTransport: MultipartUploadTransport = defaultMultipartTransport,
	) {
		this.#session = session
		this.#uploadTransport = uploadTransport
	}

	async eligibility(
		orderId: string,
		itemId?: string,
	): Promise<GuestPhotoEligibility | null> {
		const path = '/photos/eligibility'
		const query: Array<[string, string]> = [['orderId', orderId]]
		if (itemId) query.push(['itemId', itemId])
		try {
			const response = await this.#session.authorized((token) => {
				const client = this.#session.client
				return performRequest(client.transport, {
					method: 'GET',
					url: buildUrl(client.regionalBaseUrl(), path, query),
					headers: {
						Accept: 'application/json',
						Authorization: `Bearer ${token}`,
					},
					timeoutMs: client.configuration.requestTimeoutMs,
				})
			})
			return decodeResponse(response, eligibilitySchema, path)
		} catch (error) {
			if (
				error instanceof ApiError &&
				(error.status === 403 || error.status === 404)
			) {
				return null
			}
			throw error
		}
	}

	async upload(input: {
		orderId: string
		itemId: string
		file: GuestPhotoFileInput
	}): Promise<GuestPhotoUploadResult> {
		const path = '/photos/upload'
		const result = await this.#session.authorized(async (token) => {
			const client = this.#session.client
			const formData = new FormData()
			formData.append('orderId', input.orderId)
			formData.append('itemId', input.itemId)
			if ('blob' in input.file) {
				formData.append('file', input.file.blob, input.file.name)
			} else {
				formData.append('file', {
					uri: input.file.uri,
					name: input.file.name,
					type: input.file.type,
				} as unknown as Blob)
			}
			const res = await this.#uploadTransport({
				url: buildUrl(client.regionalBaseUrl(), path),
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${token}`,
				},
				body: formData,
				timeoutMs: client.configuration.requestTimeoutMs,
			})
			if (res.status < 200 || res.status >= 300) {
				throw ApiError.from(res.status, res.body)
			}
			return {
				status: res.status,
				url: buildUrl(client.regionalBaseUrl(), path),
				body: res.body,
				headers: {},
			}
		})
		return decodeResponse(result, uploadResultSchema, path)
	}

	async submit(input: {
		orderId: string
		itemId: string
		objectKey: string
		contentType: GuestPhotoMimeType
		byteSize: number
		consentText?: string
	}): Promise<GuestPhotoSubmission> {
		const path = '/photos'
		const response = await this.#session.authorized((token) => {
			const client = this.#session.client
			return performRequest(client.transport, {
				method: 'POST',
				url: buildUrl(client.regionalBaseUrl(), path),
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${token}`,
				},
				json: {
					orderId: input.orderId,
					itemId: input.itemId,
					objectKey: input.objectKey,
					contentType: input.contentType,
					byteSize: input.byteSize,
					consent: true,
					consentText: input.consentText ?? GUEST_PHOTO_CONSENT_TEXT,
				},
				timeoutMs: client.configuration.requestTimeoutMs,
			})
		})
		return decodeResponse(response, submitResponseSchema, path).submission
	}
}
