import { describe, expect, it, vi } from 'vitest'
import { uploadOrganizationImage, uploadProfileImage } from './upload-helpers'

const getConfig = vi.fn()
const options = { getConfig }

describe('image uploads reject non-raster content', () => {
	it.each([
		['html named .png', '<script>alert(1)</script>', 'x.png', 'text/html'],
		['svg named .jpg', '<svg onload="alert(1)"/>', 'x.jpg', 'image/svg+xml'],
	])('profile image: %s', async (_label, body, name, type) => {
		const file = new File([body], name, { type })
		await expect(uploadProfileImage('user1', file, options)).rejects.toThrow(
			/Invalid image content/,
		)
		expect(getConfig).not.toHaveBeenCalled()
	})

	it('organization logo: html named .png', async () => {
		const file = new File(['<html></html>'], 'logo.png', { type: 'text/html' })
		await expect(
			uploadOrganizationImage('org1', file, options),
		).rejects.toThrow(/Invalid image content/)
		expect(getConfig).not.toHaveBeenCalled()
	})
})

describe('image uploads are bounded', () => {
	it('rejects an oversized image before reading it', async () => {
		const file = new File([new Uint8Array(11 * 1024 * 1024)], 'big.png', {
			type: 'image/png',
		})
		const spy = vi.spyOn(file, 'arrayBuffer')
		await expect(uploadProfileImage('user1', file, options)).rejects.toThrow(
			/too large/,
		)
		expect(spy).not.toHaveBeenCalled()
	})
})
