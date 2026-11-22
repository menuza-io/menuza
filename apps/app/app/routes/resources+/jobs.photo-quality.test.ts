import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const quality = vi.hoisted(() => ({
	processPhotoQualityForOrganization: vi.fn(),
	sweepPhotoQuality: vi.fn(),
}))
vi.mock('#app/utils/media/photo-quality.server.ts', () => quality)

import { action } from './jobs.photo-quality.ts'

function post(
	body?: unknown,
	token: string | null = ENV.INTERNAL_COMMAND_TOKEN,
) {
	return new Request('http://localhost/resources/jobs/photo-quality', {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

const call = (request: Request) =>
	action({ request, params: {}, context: {} } as never)

describe('POST /resources/jobs/photo-quality', () => {
	beforeEach(() => {
		quality.processPhotoQualityForOrganization.mockReset()
		quality.sweepPhotoQuality.mockReset()
	})

	it('answers 405 to anything but POST', async () => {
		const response = (await call(
			new Request('http://localhost/resources/jobs/photo-quality'),
		)) as Response
		expect(response.status).toBe(405)
	})

	it('refuses a missing or wrong internal token before doing any work', async () => {
		await expect(
			call(post({ organizationId: 'org-12345678' }, null)),
		).rejects.toMatchObject({ status: 401 })
		await expect(
			call(post({ organizationId: 'org-12345678' }, 'wrong-token-wrong-token')),
		).rejects.toMatchObject({ status: 401 })
		expect(quality.processPhotoQualityForOrganization).not.toHaveBeenCalled()
		expect(quality.sweepPhotoQuality).not.toHaveBeenCalled()
	})

	it("runs one organization's batch and reports the contract fields", async () => {
		quality.processPhotoQualityForOrganization.mockResolvedValue({
			processed: 3,
			remaining: 5,
			limited: false,
		})
		const response = (await call(
			post({ organizationId: 'org-12345678' }),
		)) as Response
		expect(await response.json()).toMatchObject({
			processed: 3,
			remaining: 5,
			limited: false,
		})
		expect(quality.processPhotoQualityForOrganization).toHaveBeenCalledWith(
			'org-12345678',
		)
	})

	it('an empty body is the hourly sweep', async () => {
		quality.sweepPhotoQuality.mockResolvedValue({ organizations: 2, woken: 2 })
		const response = (await call(post())) as Response
		expect(await response.json()).toMatchObject({ success: true, woken: 2 })
	})

	it('refuses a malformed id and a malformed body', async () => {
		expect(
			((await call(post({ organizationId: 'x y' }))) as Response).status,
		).toBe(400)
		const bad = new Request('http://localhost/x', {
			method: 'POST',
			headers: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` },
			body: '{nope',
		})
		expect(((await call(bad)) as Response).status).toBe(400)
	})
})
