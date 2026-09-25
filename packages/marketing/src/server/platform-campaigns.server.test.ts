import {
	MARKETING_EMAIL_PLATFORM_SCOPE,
	buildPlatformMarketingResendTags,
} from '@repo/config/marketing-email'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSelect = vi.fn()
const mockInsert = vi.fn()
const mockUpdate = vi.fn()
const mockSendEmail = vi.fn()
const mockCreateId = vi.fn()

vi.mock('@paralleldrive/cuid2', () => ({
	createId: () => mockCreateId(),
}))

vi.mock('@repo/database', () => ({
	db: {
		select: (...args: unknown[]) => mockSelect(...args),
		insert: (...args: unknown[]) => mockInsert(...args),
		update: (...args: unknown[]) => mockUpdate(...args),
	},
	desc: vi.fn(),
	eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
	and: vi.fn((...conditions: unknown[]) => conditions),
	Organization: { id: 'id', name: 'name' },
	PlatformMarketingCampaign: {
		id: 'id',
		audience: 'audience',
		targetOrganizationId: 'targetOrganizationId',
	},
	PlatformMarketingMessage: { id: 'id', campaignId: 'campaignId' },
	User: { id: 'id', email: 'email', name: 'name', isBanned: 'isBanned' },
	UserOrganization: {
		userId: 'userId',
		organizationId: 'organizationId',
		active: 'active',
	},
}))

vi.mock('@repo/email', () => ({
	sendEmail: (...args: unknown[]) => mockSendEmail(...args),
	getEmailProvider: vi.fn(() => 'resend'),
}))

import { dispatchPlatformCampaign } from './platform-campaigns.server.ts'

function mockSelectResult(result: unknown) {
	const chain = {
		from: vi.fn().mockReturnThis(),
		innerJoin: vi.fn().mockReturnThis(),
		where: vi.fn().mockResolvedValue(result),
		orderBy: vi.fn().mockResolvedValue(result),
	}
	mockSelect.mockReturnValue(chain)
	return chain
}

function mockInsertChain() {
	const chain = {
		values: vi.fn().mockResolvedValue(undefined),
	}
	mockInsert.mockReturnValue(chain)
	return chain
}

function mockUpdateChain() {
	const chain = {
		set: vi.fn().mockReturnThis(),
		where: vi.fn().mockResolvedValue(undefined),
	}
	mockUpdate.mockReturnValue(chain)
	return chain
}

describe('dispatchPlatformCampaign', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockCreateId.mockReturnValueOnce('message-1')
		mockSendEmail.mockResolvedValue({
			status: 'success',
			data: { id: 'provider-msg-1' },
		})
	})

	it('sends email with platform marketing correlation tags', async () => {
		const campaign = {
			id: 'campaign-1',
			name: 'Product Update',
			channel: 'email',
			subject: 'Hello {{name}}',
			content: 'Welcome {{name}} from {{organizationName}}',
			audience: 'all_operators',
			targetOrganizationId: null,
		}

		mockSelect
			.mockReturnValueOnce({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockResolvedValue([campaign]),
				}),
			})
			.mockReturnValueOnce(
				mockSelectResult([
					{
						userId: 'user-1',
						email: 'operator@example.com',
						name: 'Ada Lovelace',
						organizationName: 'Acme Corp',
					},
				]),
			)

		mockInsertChain()
		mockUpdateChain()

		await dispatchPlatformCampaign('campaign-1')

		expect(mockSendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: 'operator@example.com',
				subject: 'Hello Ada Lovelace',
				text: 'Welcome Ada Lovelace from Acme Corp',
				tags: buildPlatformMarketingResendTags('message-1', 'campaign-1'),
			}),
		)
		expect(mockSendEmail.mock.calls[0]?.[0]?.tags).toEqual(
			expect.objectContaining({
				menuza_scope: MARKETING_EMAIL_PLATFORM_SCOPE,
				menuza_message_id: 'message-1',
				menuza_campaign_id: 'campaign-1',
			}),
		)
	})

	it('deduplicates recipients when a user belongs to multiple organizations', async () => {
		const campaign = {
			id: 'campaign-2',
			name: 'Broadcast',
			channel: 'sms',
			subject: null,
			content: 'Ignored for SMS channel in this test',
			audience: 'all_operators',
			targetOrganizationId: null,
		}

		mockSelect
			.mockReturnValueOnce({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockResolvedValue([campaign]),
				}),
			})
			.mockReturnValueOnce(
				mockSelectResult([
					{
						userId: 'user-1',
						email: 'operator@example.com',
						name: 'Ada',
						organizationName: 'Acme',
					},
					{
						userId: 'user-1',
						email: 'operator@example.com',
						name: 'Ada',
						organizationName: 'Beta',
					},
				]),
			)

		mockInsertChain()
		const updateChain = mockUpdateChain()

		await dispatchPlatformCampaign('campaign-2')

		expect(mockInsert).toHaveBeenCalledTimes(1)
		expect(updateChain.set).toHaveBeenCalledWith(
			expect.objectContaining({ targetAudienceCount: 1 }),
		)
		expect(mockSendEmail).not.toHaveBeenCalled()
	})
})
