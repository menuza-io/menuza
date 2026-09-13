import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
	getMarketingMessageIdFromTags,
	marketingTagsToOciHeaders,
} from './marketing-tags-to-headers.ts'
import { getEmailProvider, isOciEmailProvider } from './provider.ts'

vi.mock('./oci/send-oci-email.ts', () => ({
	sendOciEmail: vi.fn().mockResolvedValue({
		status: 'success',
		data: { messageId: 'oci-msg-1' },
	}),
}))

import { sendOciEmail } from './oci/send-oci-email.ts'
import { sendEmail } from './send-email.ts'

describe('email provider', () => {
	beforeEach(() => {
		vi.unstubAllEnvs()
		vi.mocked(sendOciEmail).mockClear()
	})

	it('defaults to resend', () => {
		expect(getEmailProvider()).toBe('resend')
		expect(isOciEmailProvider()).toBe(false)
	})

	it('switches to oci when EMAIL_PROVIDER=oci', () => {
		vi.stubEnv('EMAIL_PROVIDER', 'oci')
		expect(getEmailProvider()).toBe('oci')
		expect(isOciEmailProvider()).toBe(true)
	})
})

describe('marketingTagsToOciHeaders', () => {
	it('maps platform marketing tags to OCI headers', () => {
		const headers = marketingTagsToOciHeaders({
			menuza_scope: 'platform',
			menuza_message_id: 'msg-1',
			menuza_campaign_id: 'camp-1',
		})

		expect(headers).toEqual({
			'X-Menuza-Message-Id': 'msg-1',
			'X-Menuza-Campaign-Id': 'camp-1',
		})
		expect(
			getMarketingMessageIdFromTags({
				menuza_message_id: 'msg-1',
			}),
		).toBe('msg-1')
	})
})

describe('sendEmail routing', () => {
	beforeEach(() => {
		vi.unstubAllEnvs()
		vi.mocked(sendOciEmail).mockClear()
		vi.stubEnv('NODE_ENV', 'test')
	})

	it('uses OCI when EMAIL_PROVIDER=oci', async () => {
		vi.stubEnv('EMAIL_PROVIDER', 'oci')

		const result = await sendEmail({
			to: 'user@example.com',
			subject: 'Hello',
			html: '<p>Hi</p>',
			text: 'Hi',
			tags: {
				menuza_message_id: 'msg-1',
				menuza_campaign_id: 'camp-1',
			},
		})

		expect(sendOciEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: 'user@example.com',
				subject: 'Hello',
				messageId: 'msg-1',
				headerFields: {
					'X-Menuza-Message-Id': 'msg-1',
					'X-Menuza-Campaign-Id': 'camp-1',
				},
			}),
		)
		expect(result).toEqual({ status: 'success', data: { id: 'oci-msg-1' } })
	})
})
