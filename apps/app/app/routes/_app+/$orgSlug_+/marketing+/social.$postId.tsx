import { i18n as linguiI18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { redirectWithToast } from '@repo/common/toast'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import { getHints } from '@repo/ui/client-hints'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import { PageHeader } from '@repo/ui/page-header'
import { useEffect } from 'react'
import {
	Form,
	Link,
	useActionData,
	useLoaderData,
	useNavigation,
	useRevalidator,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { SocialPostComposer } from '#app/components/social/post-composer.tsx'
import {
	SOCIAL_PLATFORM_LABELS,
	socialTargetError,
} from '#app/components/social/social-labels.ts'
import {
	SocialPlatformIcon,
	SocialPostStatusBadge,
	SocialTargetStatusBadge,
} from '#app/components/social/social-ui.tsx'
import { runAfterResponse } from '#app/utils/after-response.server.ts'
import { requireSocialAccess } from '#app/utils/social/access.server.ts'
import { listSocialAccounts } from '#app/utils/social/accounts.server.ts'
import { handleSocialPostForm } from '#app/utils/social/post-form.server.ts'
import {
	deleteSocialPost,
	getSocialPost,
	retrySocialPost,
	saveSocialPost,
} from '#app/utils/social/posts.server.ts'
import { toLocalInputValue } from '#app/utils/social/time.ts'

/** While a post is publishing, the page refreshes this often. */
const PUBLISHING_POLL_MS = 3_000

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireSocialAccess(request, params.orgSlug)
	const post = await getSocialPost(access.organization.id, params.postId ?? '')
	if (!post) throw new Response('Not Found', { status: 404 })
	const { timeZone } = getHints(request)
	const editable =
		access.canWrite && (post.status === 'draft' || post.status === 'scheduled')
	return {
		orgSlug: access.organization.slug,
		canWrite: access.canWrite,
		timeZone,
		editable,
		post,
		scheduledAt: post.scheduledAt
			? toLocalInputValue(post.scheduledAt, timeZone)
			: '',
		accounts: editable ? await listSocialAccounts(access.organization.id) : [],
	}
}

export async function action({ request, params, context }: ActionFunctionArgs) {
	const access = await requireSocialAccess(request, params.orgSlug, {
		write: true,
	})
	const postId = params.postId ?? ''
	const organizationId = access.organization.id
	const calendar = `/${access.organization.slug}/marketing/social`
	const intent = (await request.clone().formData()).get('intent')

	if (intent === 'delete') {
		if (!(await deleteSocialPost(organizationId, postId))) {
			return { error: 'busy' as const }
		}
		return redirectWithToast(calendar, {
			type: 'success',
			description: linguiI18n._(t`Post deleted.`),
		})
	}

	if (intent === 'retry') {
		if (!(await retrySocialPost(organizationId, postId))) {
			return { error: 'busy' as const }
		}
		return redirectWithToast(`${calendar}/${postId}`, {
			type: 'success',
			description: linguiI18n._(t`Sent again. See each account below.`),
		})
	}

	if (intent === 'duplicate') {
		const post = await getSocialPost(organizationId, postId)
		if (!post) throw new Response('Not Found', { status: 404 })
		const copy = await saveSocialPost(access, {
			body: post.body,
			mediaIds: post.media.map((item) => item.mediaId),
			accountIds: post.targets.flatMap((target) =>
				target.socialAccountId ? [target.socialAccountId] : [],
			),
			status: 'draft',
			scheduledAt: null,
		})
		return redirectWithToast(`${calendar}/${copy.id}`, {
			type: 'success',
			description: linguiI18n._(t`Copied to a new draft.`),
		})
	}

	const post = await getSocialPost(organizationId, postId)
	if (!post) throw new Response('Not Found', { status: 404 })
	return handleSocialPostForm(request, access, postId, {
		publishInBackground: (task) => runAfterResponse(context, task),
	})
}

function DeletePostDialog({ published }: { published: boolean }) {
	const { _ } = useLingui()
	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={
					<Button variant="ghost" className="text-muted-foreground">
						<Icon name="trash-2" />
						{_(msg`Delete post`)}
					</Button>
				}
			/>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{_(msg`Delete this post?`)}</AlertDialogTitle>
					<AlertDialogDescription>
						{published
							? _(
									msg`It leaves the calendar here. What is already on Facebook or Instagram stays there: delete it on the platform if needed.`,
								)
							: _(msg`It will not be published.`)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{_(msg`Keep it`)}</AlertDialogCancel>
					<Form method="post">
						<Button
							type="submit"
							name="intent"
							value="delete"
							variant="destructive"
						>
							{_(msg`Delete`)}
						</Button>
					</Form>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

export default function SocialPostRoute() {
	const { _, i18n } = useLingui()
	const { orgSlug, canWrite, timeZone, editable, post, scheduledAt, accounts } =
		useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const navigation = useNavigation()
	const revalidator = useRevalidator()
	const busyIntent =
		navigation.state === 'submitting'
			? navigation.formData?.get('intent')
			: null

	const publishing = post.status === 'publishing'
	useEffect(() => {
		if (!publishing) return
		const timer = setInterval(() => {
			if (revalidator.state === 'idle') void revalidator.revalidate()
		}, PUBLISHING_POLL_MS)
		return () => clearInterval(timer)
	}, [publishing, revalidator])

	const when = new Intl.DateTimeFormat(i18n.locale, {
		dateStyle: 'full',
		timeStyle: 'short',
		timeZone,
	})
	const description = (() => {
		if (post.publishedAt) {
			const date = when.format(new Date(post.publishedAt))
			return _(msg`Published ${date}`)
		}
		if (post.status === 'scheduled' && post.scheduledAt) {
			const date = when.format(new Date(post.scheduledAt))
			return _(msg`Scheduled for ${date}`)
		}
		if (post.status === 'publishing') return _(msg`Publishing now…`)
		if (post.status === 'failed') return _(msg`Nothing was published.`)
		return _(msg`Not published yet.`)
	})()
	const errors =
		actionData && 'error' in actionData ? actionData.error : undefined
	const hasFailed = post.targets.some((target) => target.status === 'failed')

	return (
		<div className="space-y-8">
			<PageHeader
				title={
					<span className="flex flex-wrap items-center gap-3">
						{editable ? _(msg`Edit post`) : _(msg`Post`)}
						<SocialPostStatusBadge status={post.status} />
					</span>
				}
				description={description}
				actions={
					<Button
						variant="outline"
						render={<Link to={`/${orgSlug}/marketing/social`} />}
					>
						<Icon name="calendar-days" />
						{_(msg`Calendar`)}
					</Button>
				}
			/>

			{errors === 'busy' ? (
				<p className="text-destructive text-sm" role="alert">
					{_(msg`This post is publishing right now. Try again in a moment.`)}
				</p>
			) : null}

			{editable ? (
				<>
					<SocialPostComposer
						key={post.updatedAt.toString()}
						id={`social-post-${post.id}`}
						orgSlug={orgSlug}
						accounts={accounts}
						defaults={{
							body: post.body,
							accountIds: post.targets.flatMap((target) =>
								target.socialAccountId ? [target.socialAccountId] : [],
							),
							media: post.media,
							scheduledAt,
						}}
						lastResult={
							actionData && 'result' in actionData
								? actionData.result
								: undefined
						}
						timeZone={timeZone}
						cancelTo={`/${orgSlug}/marketing/social`}
					/>
					<DeletePostDialog published={false} />
				</>
			) : (
				<div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
					<section
						aria-labelledby="social-results-heading"
						className="space-y-3"
					>
						<h2 id="social-results-heading" className="text-sm font-medium">
							{_(msg`Where it went`)}
						</h2>
						<ItemGroup>
							{post.targets.map((target) => {
								const error = socialTargetError(_, target.error)
								const platformName = _(SOCIAL_PLATFORM_LABELS[target.platform])
								return (
									<Item key={target.id} variant="outline" size="sm">
										<ItemMedia variant="icon">
											<SocialPlatformIcon platform={target.platform} />
										</ItemMedia>
										<ItemContent>
											<ItemTitle className="wrap-anywhere">
												{target.accountName}
											</ItemTitle>
											<ItemDescription>
												{target.publishedAt
													? when.format(new Date(target.publishedAt))
													: platformName}
											</ItemDescription>
											{error ? (
												<p className="text-destructive text-sm wrap-anywhere">
													{error}
												</p>
											) : null}
										</ItemContent>
										<ItemActions>
											<SocialTargetStatusBadge status={target.status} />
											{target.permalink ? (
												<Button
													variant="ghost"
													size="sm"
													render={
														<a
															href={target.permalink}
															target="_blank"
															rel="noreferrer noopener"
														/>
													}
												>
													<Icon name="external-link" />
													{_(msg`View on ${platformName}`)}
												</Button>
											) : null}
										</ItemActions>
									</Item>
								)
							})}
						</ItemGroup>

						{canWrite ? (
							<div className="flex flex-wrap gap-3 pt-2">
								{hasFailed && post.status !== 'publishing' ? (
									<Form method="post">
										<Button
											type="submit"
											name="intent"
											value="retry"
											disabled={busyIntent != null}
										>
											<Icon
												name={busyIntent === 'retry' ? 'loader' : 'refresh-cw'}
											/>
											{_(msg`Retry failed accounts`)}
										</Button>
									</Form>
								) : null}
								<Form method="post">
									<Button
										type="submit"
										name="intent"
										value="duplicate"
										variant="outline"
										disabled={busyIntent != null}
									>
										<Icon name="copy" />
										{_(msg`Copy to new draft`)}
									</Button>
								</Form>
								{post.status !== 'publishing' ? (
									<DeletePostDialog published />
								) : null}
							</div>
						) : null}
					</section>

					<aside className="space-y-3">
						<h2 className="text-sm font-medium">{_(msg`Content`)}</h2>
						<div className="border-border bg-card space-y-3 rounded-lg border p-4">
							{post.body ? (
								<p className="text-sm wrap-anywhere whitespace-pre-wrap">
									{post.body}
								</p>
							) : null}
							{post.media.length > 0 ? (
								<ul className="grid grid-cols-3 gap-2">
									{post.media.map((item) => (
										<li
											key={item.mediaId}
											className="border-border aspect-square overflow-hidden rounded-md border"
										>
											<img
												src={item.url}
												alt={item.altText ?? ''}
												className="size-full object-cover"
											/>
										</li>
									))}
								</ul>
							) : null}
						</div>
					</aside>
				</div>
			)}
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
