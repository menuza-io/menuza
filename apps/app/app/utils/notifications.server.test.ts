import type * as DatabaseModule from '@repo/database'
import { sendEmail } from '@repo/email'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
	mockDb,
	mockSelectResults,
	resetMockDb,
} from '#tests/setup/drizzle-mock.ts'
import {
	notifyCommentMentions,
	notifyNoteOwner,
} from './notifications.server.ts'

vi.hoisted(() => {
	process.env.BASE_URL = 'http://localhost:3000'
})

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	const { mockDb, drizzleTable, drizzleOperator } =
		await import('#tests/setup/drizzle-mock.ts')
	return {
		...actual,
		db: mockDb,
		Notification: drizzleTable,
		NotificationPreference: drizzleTable,
		User: drizzleTable,
		UserOrganization: drizzleTable,
		and: drizzleOperator,
		eq: drizzleOperator,
	}
})

vi.mock('@repo/email', () => ({
	sendEmail: vi.fn().mockResolvedValue({ status: 'success' }),
	MentionEmail: vi.fn().mockReturnValue('MentionEmailComponent'),
	CommentEmail: vi.fn().mockReturnValue('CommentEmailComponent'),
}))

describe('Notifications Server Utils', () => {
	beforeEach(() => {
		resetMockDb()
	})

	describe('notifyCommentMentions', () => {
		it('should not notify if no mentions found', async () => {
			await notifyCommentMentions({
				noteId: 'note1',
				noteTitle: 'Note 1',
				noteOwnerId: 'owner1',
				commentId: 'comment1',
				commenterUserId: 'user1',
				commenterName: 'Commenter',
				commentContent: 'Hello world',
				organizationId: 'org1',
				organizationSlug: 'acme',
			})
			expect(mockDb.select).not.toHaveBeenCalled()
		})

		it('should notify mentioned users if preferences allow', async () => {
			mockSelectResults(
				[
					{
						userId: 'user2',
						user: {
							id: 'user2',
							username: 'testuser',
							email: 'test@example.com',
							name: 'Test User',
						},
					},
				],
				[],
			)

			await notifyCommentMentions({
				noteId: 'note1',
				noteTitle: 'Note 1',
				noteOwnerId: 'owner1',
				commentId: 'comment1',
				commenterUserId: 'user1',
				commenterName: 'Commenter',
				commentContent: 'Hello @testuser',
				organizationId: 'org1',
				organizationSlug: 'acme',
			})

			expect(mockDb.select).toHaveBeenCalledTimes(2)
			expect(mockDb.insert).toHaveBeenCalledTimes(1)
			expect(sendEmail).toHaveBeenCalledWith(
				expect.objectContaining({
					to: 'test@example.com',
					subject: 'Commenter mentioned you in a comment',
				}),
			)
		})

		it('should respect false preferences', async () => {
			mockSelectResults(
				[
					{
						userId: 'user2',
						user: {
							id: 'user2',
							username: 'testuser',
							email: 'test@example.com',
							name: 'Test User',
						},
					},
				],
				[{ inApp: false, email: false }],
			)

			await notifyCommentMentions({
				noteId: 'note1',
				noteTitle: 'Note 1',
				noteOwnerId: 'owner1',
				commentId: 'comment1',
				commenterUserId: 'user1',
				commenterName: 'Commenter',
				commentContent: 'Hello @testuser',
				organizationId: 'org1',
				organizationSlug: 'acme',
			})

			expect(mockDb.insert).not.toHaveBeenCalled()
			expect(sendEmail).not.toHaveBeenCalled()
		})
	})

	describe('notifyNoteOwner', () => {
		it('should not notify if commenter is the note owner', async () => {
			await notifyNoteOwner({
				noteId: 'note1',
				noteTitle: 'Note 1',
				noteOwnerId: 'user1',
				commentId: 'comment1',
				commenterUserId: 'user1',
				commenterName: 'User 1',
				commentContent: 'My comment',
				organizationId: 'org1',
				organizationSlug: 'acme',
			})
			expect(mockDb.select).not.toHaveBeenCalled()
		})

		it('should create notification and send email if preferences allow', async () => {
			mockSelectResults([{ email: 'owner@example.com' }], [])

			await notifyNoteOwner({
				noteId: 'note1',
				noteTitle: 'Note 1',
				noteOwnerId: 'owner1',
				commentId: 'comment1',
				commenterUserId: 'user2',
				commenterName: 'User 2',
				commentContent: 'A comment',
				organizationId: 'org1',
				organizationSlug: 'acme',
			})

			expect(mockDb.select).toHaveBeenCalledTimes(2)
			expect(mockDb.insert).toHaveBeenCalledTimes(1)
			expect(sendEmail).toHaveBeenCalledWith(
				expect.objectContaining({
					to: 'owner@example.com',
					subject: 'New comment on "Note 1"',
				}),
			)
		})
	})
})
