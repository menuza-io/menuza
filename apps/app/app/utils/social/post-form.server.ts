import { parseWithZod } from '@conform-to/zod'
import { i18n } from '@lingui/core'
import { t } from '@lingui/macro'
import { redirectWithToast } from '@repo/common/toast'
import { type SocialAccess } from './access.server.ts'
import { socialPostProblems } from './platforms.ts'
import { SocialPostFormSchema } from './post-schema.ts'
import { fromLocalInputValue } from './time.ts'
import { wakeSocialPublisherAt } from './wake.server.ts'
import {
	publishSocialPost,
	resolveSocialAccounts,
	resolveSocialMedia,
	saveSocialPost,
	SocialPostConflict,
} from './posts.server.ts'

/**
 * Saves the composer: a draft, a scheduled post, or a post published now
 * (it is scheduled for this instant and sent before the redirect).
 */
export async function handleSocialPostForm(
	request: Request,
	access: SocialAccess,
	postId?: string,
	options?: {
		/** Publish after the redirect (Workers `waitUntil`). Tests run inline. */
		publishInBackground?: (task: () => Promise<unknown>) => void
	},
) {
	const submission = parseWithZod(await request.formData(), {
		schema: SocialPostFormSchema,
	})
	if (submission.status !== 'success') {
		return { result: submission.reply() }
	}
	const { intent, body, accountIds, mediaIds, scheduledAt, timeZone } =
		submission.value
	const organizationId = access.organization.id

	if (intent !== 'draft') {
		const [accounts, media] = await Promise.all([
			resolveSocialAccounts(organizationId, accountIds),
			resolveSocialMedia(organizationId, mediaIds),
		])
		if (accounts.length === 0) {
			return {
				result: submission.reply({
					fieldErrors: { accountIds: ['accounts_required'] },
				}),
			}
		}
		const problems = socialPostProblems({
			body,
			mediaCount: media.length,
			platforms: accounts.map((account) => account.platform),
		})
		if (problems.length > 0) {
			return {
				result: submission.reply({
					formErrors: problems.map((p) => `${p.platform}:${p.problem}`),
				}),
			}
		}
	}

	const now = new Date()
	let saved: { id: string }
	try {
		saved = await saveSocialPost(
			access,
			{
				body,
				mediaIds,
				accountIds,
				status: intent === 'draft' ? 'draft' : 'scheduled',
				scheduledAt:
					intent === 'publish'
						? now
						: scheduledAt
							? fromLocalInputValue(scheduledAt, timeZone)
							: null,
			},
			postId,
		)
	} catch (error) {
		if (error instanceof SocialPostConflict) {
			return { result: submission.reply({ formErrors: ['not_editable'] }) }
		}
		throw error
	}

	if (intent === 'publish') {
		const publish = () => publishSocialPost(saved.id, now)
		if (options?.publishInBackground) {
			options.publishInBackground(publish)
		} else {
			await publish()
		}
	}
	if (intent === 'schedule' && scheduledAt) {
		await wakeSocialPublisherAt(
			saved.id,
			fromLocalInputValue(scheduledAt, timeZone),
		)
	}

	const description =
		intent === 'draft'
			? i18n._(t`Draft saved.`)
			: intent === 'schedule'
				? i18n._(t`Post scheduled.`)
				: i18n._(t`Post sent. See each account below.`)
	return redirectWithToast(
		`/${access.organization.slug}/marketing/social/${saved.id}`,
		{ type: 'success', description },
	)
}
