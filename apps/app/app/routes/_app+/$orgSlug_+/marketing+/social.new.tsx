import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getHints } from '@repo/ui/client-hints'
import { PageHeader } from '@repo/ui/page-header'
import {
	useActionData,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { SocialPostComposer } from '#app/components/social/post-composer.tsx'
import { runAfterResponse } from '#app/utils/after-response.server.ts'
import { requireSocialAccess } from '#app/utils/social/access.server.ts'
import { listSocialAccounts } from '#app/utils/social/accounts.server.ts'
import { handleSocialPostForm } from '#app/utils/social/post-form.server.ts'
import { schedulePrefillForDay, dayKey } from '#app/utils/social/time.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireSocialAccess(request, params.orgSlug, {
		write: true,
	})
	const { timeZone } = getHints(request)
	// Opened from a calendar day: suggest 9:00 that day.
	const date = new URL(request.url).searchParams.get('date')
	const validDate =
		date &&
		/^\d{4}-\d{2}-\d{2}$/u.test(date) &&
		date >= dayKey(new Date(), timeZone)
			? date
			: null
	const now = new Date()
	return {
		orgSlug: access.organization.slug,
		timeZone,
		scheduledAt: validDate
			? schedulePrefillForDay(validDate, timeZone, now)
			: '',
		accounts: await listSocialAccounts(access.organization.id),
	}
}

export async function action({ request, params, context }: ActionFunctionArgs) {
	const access = await requireSocialAccess(request, params.orgSlug, {
		write: true,
	})
	return handleSocialPostForm(request, access, undefined, {
		publishInBackground: (task) => runAfterResponse(context, task),
	})
}

export default function NewSocialPostRoute() {
	const { _ } = useLingui()
	const { orgSlug, timeZone, scheduledAt, accounts } =
		useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`New post`)}
				description={_(
					msg`Write once, then publish now, schedule it, or keep it as a draft.`,
				)}
			/>
			<SocialPostComposer
				id="new-social-post"
				orgSlug={orgSlug}
				accounts={accounts}
				defaults={{ body: '', accountIds: [], media: [], scheduledAt }}
				lastResult={actionData?.result}
				timeZone={timeZone}
				cancelTo={`/${orgSlug}/marketing/social`}
			/>
		</div>
	)
}
