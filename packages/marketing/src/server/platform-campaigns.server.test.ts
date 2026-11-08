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
	lt: vi.fn((left: unknown, right: unknown) => ({ lt: [left, right] })),
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

import {
	createPlatformCampaign,
	dispatchPlatformCampaign,
	resumeStalePlatformCampaigns,
} from './platform-campaigns.server.ts'

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

/** A select that finds nothing (existing messages, unconfirmed count). */
function emptySelect() {
	return {
		from: vi.fn().mockReturnValue({
			where: vi.fn().mockResolvedValue([]),
		}),
	}
}

function mockInsertChain() {
	const chain = {
		values: vi.fn().mockReturnValue({
			onConflictDoNothing: () => ({
				returning: vi.fn().mockResolvedValue([{ id: 'inserted' }]),
			}),
		}),
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
			status: 'Processing',
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
			.mockReturnValueOnce(emptySelect())
			.mockReturnValueOnce(emptySelect())

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
			status: 'Processing',
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
			.mockReturnValueOnce(emptySelect())
			.mockReturnValueOnce(emptySelect())

		mockInsertChain()
		const updateChain = mockUpdateChain()

		await dispatchPlatformCampaign('campaign-2')

		expect(mockInsert).toHaveBeenCalledTimes(1)
		expect(updateChain.set).toHaveBeenCalledWith(
			expect.objectContaining({ targetAudienceCount: 1 }),
		)
		expect(mockSendEmail).not.toHaveBeenCalled()
	})

	it('resumes without re-sending to users who already have a message row', async () => {
		const campaign = {
			id: 'campaign-3',
			name: 'Resumed',
			channel: 'email',
			subject: 'Hi',
			content: 'Hello {{name}}',
			audience: 'all_operators',
			targetOrganizationId: null,
			status: 'Processing',
		}
		const recipients = ['user-sent', 'user-unknown', 'user-new'].map(
			(userId) => ({
				userId,
				email: `${userId}@example.com`,
				name: userId,
				organizationName: 'Acme',
			}),
		)
		const existingMessages = [
			{ userId: 'user-sent', status: 'Sent' },
			// Interrupted mid-send: the outcome is unknown, so never re-send.
			{ userId: 'user-unknown', status: 'Processing' },
		]
		mockSelect
			.mockReturnValueOnce({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockResolvedValue([campaign]),
				}),
			})
			.mockReturnValueOnce(mockSelectResult(recipients))
			.mockReturnValueOnce({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockResolvedValue(existingMessages),
				}),
			})
			// After the send, the interrupted row is still Processing.
			.mockReturnValueOnce({
				from: vi.fn().mockReturnValue({
					where: vi.fn().mockResolvedValue([{ id: 'message-unknown' }]),
				}),
			})
		const insertChain = mockInsertChain()
		const updateChain = mockUpdateChain()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		await dispatchPlatformCampaign('campaign-3')

		expect(mockSendEmail.mock.calls.map((call) => call[0].to)).toEqual([
			'user-new@example.com',
		])
		expect(insertChain.values).toHaveBeenCalledTimes(1)
		expect(insertChain.values).toHaveBeenCalledWith(
			expect.objectContaining({ userId: 'user-new' }),
		)
		expect(updateChain.set).toHaveBeenCalledWith({ status: 'Completed' })
		// A resume keeps the audience count of the first dispatch.
		expect(updateChain.set).not.toHaveBeenCalledWith(
			expect.objectContaining({ targetAudienceCount: expect.anything() }),
		)
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('1 unconfirmed recipient'),
		)
		warn.mockRestore()
	})

	it('does not dispatch a campaign that is no longer Processing', async () => {
		mockSelect.mockReturnValueOnce({
			from: vi.fn().mockReturnValue({
				where: vi
					.fn()
					.mockResolvedValue([{ id: 'campaign-4', status: 'Completed' }]),
			}),
		})
		mockInsertChain()
		mockUpdateChain()

		await dispatchPlatformCampaign('campaign-4')

		expect(mockInsert).not.toHaveBeenCalled()
		expect(mockSendEmail).not.toHaveBeenCalled()
	})

	it('hands the dispatch to the caller-provided background runner', async () => {
		mockCreateId.mockReset()
		mockCreateId.mockReturnValue('campaign-5')
		mockInsertChain()
		const runInBackground = vi.fn()

		await createPlatformCampaign(
			{
				name: 'Launch',
				channel: 'email',
				subject: 'Hi',
				content: 'Hello',
				audience: 'all_operators',
			},
			'admin-1',
			{ runInBackground },
		)

		expect(runInBackground).toHaveBeenCalledTimes(1)
		expect(runInBackground.mock.calls[0]?.[0]).toEqual(expect.any(Function))
		expect(mockSelect).not.toHaveBeenCalled()
	})

	it('resumes each stale Processing campaign once, only after claiming it', async () => {
		mockSelect.mockReturnValueOnce({
			from: vi.fn().mockReturnValue({
				where: vi
					.fn()
					.mockResolvedValue([{ id: 'stale-1' }, { id: 'stale-2' }]),
			}),
		})
		const returning = vi
			.fn()
			.mockResolvedValueOnce([{ id: 'stale-1' }])
			// Another caller claimed stale-2 first.
			.mockResolvedValueOnce([])
		mockUpdate.mockReturnValue({
			set: vi.fn().mockReturnThis(),
			where: vi.fn().mockReturnValue({ returning }),
		})
		const runInBackground = vi.fn()

		const result = await resumeStalePlatformCampaigns({ runInBackground })

		expect(result).toEqual({ resumed: ['stale-1'] })
		expect(runInBackground).toHaveBeenCalledTimes(1)
	})
})
