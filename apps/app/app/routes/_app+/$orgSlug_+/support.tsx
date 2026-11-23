import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import {
	SUPPORT_MESSAGE_MAX,
	replySchema,
	type SupportRequestStatus,
} from '@repo/common/support-requests'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { PageTitle } from '@repo/ui/page-title'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useRef } from 'react'
import {
	Link,
	data,
	useFetcher,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { useOptionalHelp } from '#app/components/help/help-context.tsx'
import { refuseWhileImpersonating } from '#app/utils/impersonation-guard.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	checkRateLimit,
	createRateLimitResponse,
	SUPPORT_REPLY_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import {
	closeSupportRequest,
	getSupportThread,
	listSupportRequests,
	markSupportThreadRead,
	postMemberReply,
	resolveSupportOrganization,
} from '#app/utils/support.server.ts'

/**
 * Support (#406): the restaurant's own requests with their status, thread and
 * unread replies. Members with the support permission see every request of the
 * restaurant, other members only their own; nobody sees another restaurant's.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	// Membership first (404 for a restaurant the member does not belong to), then
	// the support permission.
	await requireUserOrganization(request, params.orgSlug, { id: true })
	const userId = await requireUserId(request)
	const organization = await resolveSupportOrganization(
		userId,
		params.orgSlug ?? '',
	)
	if (!organization) throw new Response('Not Found', { status: 404 })
	const user = { id: userId }
	const url = new URL(request.url)
	const selectedId = url.searchParams.get('request')
	const [requests, thread] = await Promise.all([
		listSupportRequests(user, organization),
		selectedId ? getSupportThread(user, organization, selectedId) : null,
	])
	return {
		organization: { slug: organization.slug, name: organization.name },
		canManageSupport: organization.canManageSupport,
		requests,
		thread,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserOrganization(request, params.orgSlug, { id: true })
	const userId = await requireUserId(request)
	const organization = await resolveSupportOrganization(
		userId,
		params.orgSlug ?? '',
	)
	if (!organization) throw new Response('Not Found', { status: 404 })
	await refuseWhileImpersonating(
		request,
		'Stop impersonating before writing to support',
	)
	const user = { id: userId }
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')
	const requestId = String(form.get('requestId') ?? '')
	if (!requestId || requestId.length > 64) {
		throw data({ error: 'not_found' }, { status: 404 })
	}

	if (intent === 'read') {
		await markSupportThreadRead(user, organization, requestId)
		return data({ ok: true })
	}
	if (intent === 'close') {
		const result = await closeSupportRequest({
			user,
			organization,
			requestId,
			request,
		})
		if (result === 'not_found')
			throw data({ error: 'not_found' }, { status: 404 })
		return data({ ok: true })
	}
	if (intent === 'reply') {
		const limit = await checkRateLimit(
			{ type: 'user', value: userId },
			SUPPORT_REPLY_RATE_LIMIT,
		)
		if (!limit.allowed) return createRateLimitResponse(limit.resetAt)
		const parsed = replySchema.safeParse({ message: form.get('message') })
		if (!parsed.success) {
			return data({ ok: false, error: 'invalid' as const }, { status: 400 })
		}
		const result = await postMemberReply({
			user,
			organization,
			requestId,
			body: parsed.data.message,
			request,
		})
		if (result === 'not_found')
			throw data({ error: 'not_found' }, { status: 404 })
		return data({ ok: true })
	}
	throw data({ error: 'invalid_intent' }, { status: 400 })
}

function useStatusLabel() {
	const { _ } = useLingui()
	return (status: SupportRequestStatus) => {
		switch (status) {
			case 'open':
				return _(msg`Open`)
			case 'waiting_on_you':
				return _(msg`Waiting on you`)
			case 'closed':
				return _(msg`Closed`)
		}
	}
}

function statusVariant(status: SupportRequestStatus) {
	return status === 'waiting_on_you'
		? ('default' as const)
		: status === 'closed'
			? ('outline' as const)
			: ('secondary' as const)
}

export default function SupportPage() {
	const { organization, requests, thread, canManageSupport } =
		useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const help = useOptionalHelp()
	const statusLabel = useStatusLabel()
	const readFetcher = useFetcher()
	const replyFetcher = useFetcher<{ ok?: boolean; error?: string }>()
	const closeFetcher = useFetcher()
	const replyRef = useRef<HTMLFormElement>(null)
	const markedRead = useRef<string | null>(null)

	// Opening a thread reads it: the unread badge clears.
	useEffect(() => {
		if (thread?.unread && markedRead.current !== thread.id) {
			markedRead.current = thread.id
			void readFetcher.submit(
				{ intent: 'read', requestId: thread.id },
				{ method: 'POST' },
			)
		}
	}, [thread?.id, thread?.unread, readFetcher])

	useEffect(() => {
		if (replyFetcher.state === 'idle' && replyFetcher.data?.ok) {
			replyRef.current?.reset()
		}
	}, [replyFetcher.state, replyFetcher.data])

	const base = `/${organization.slug}/support`

	return (
		<div className="mx-auto w-full max-w-5xl py-6 md:p-8">
			<div className="mb-6 flex flex-wrap items-start justify-between gap-3">
				<PageTitle
					title={_(msg`Support`)}
					description={
						canManageSupport
							? _(
									msg`Requests your team has sent to Menuza support, and the replies.`,
								)
							: _(
									msg`Requests you have sent to Menuza support, and the replies.`,
								)
					}
				/>
				{help ? (
					<Button onClick={() => help.open({ kind: 'support' })}>
						<Trans>Contact support</Trans>
					</Button>
				) : null}
			</div>

			{requests.length === 0 ? (
				<Card>
					<CardContent className="text-muted-foreground py-10 text-center">
						<Trans>
							No support requests yet. Use Help, then Contact support, and we
							will reply here.
						</Trans>
					</CardContent>
				</Card>
			) : (
				<div className="grid gap-4 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
					<ul className="space-y-2" aria-label={_(msg`Support requests`)}>
						{requests.map((item) => (
							<li key={item.id}>
								<Link
									to={`${base}?request=${item.id}`}
									className={`hover:bg-muted block rounded-lg border p-3 ${
										thread?.id === item.id ? 'bg-muted' : ''
									}`}
								>
									<div className="flex items-center justify-between gap-2">
										<Badge variant={statusVariant(item.status)}>
											{statusLabel(item.status)}
										</Badge>
										{item.unread ? (
											<span
												className="bg-primary size-2.5 rounded-full"
												role="img"
												aria-label={_(msg`Unread reply`)}
											/>
										) : null}
									</div>
									<p className="mt-2 truncate text-sm font-medium">
										{item.subject || item.preview}
									</p>
									{item.senderName ? (
										<p className="text-muted-foreground text-xs">
											{item.senderName}
										</p>
									) : null}
									<p className="text-muted-foreground mt-1 text-xs">
										{new Date(item.lastMessageAt).toLocaleString()}
									</p>
								</Link>
							</li>
						))}
					</ul>

					<div>
						{thread ? (
							<Card>
								<CardHeader className="flex flex-row items-start justify-between gap-3">
									<div className="space-y-1">
										<CardTitle className="text-base">
											{thread.subject || _(msg`Support request`)}
										</CardTitle>
										<Badge variant={statusVariant(thread.status)}>
											{statusLabel(thread.status)}
										</Badge>
									</div>
									{thread.status !== 'closed' ? (
										<closeFetcher.Form method="post">
											<input type="hidden" name="intent" value="close" />
											<input type="hidden" name="requestId" value={thread.id} />
											<Button
												type="submit"
												variant="outline"
												size="sm"
												disabled={closeFetcher.state !== 'idle'}
											>
												<Trans>Mark as solved</Trans>
											</Button>
										</closeFetcher.Form>
									) : null}
								</CardHeader>
								<CardContent className="space-y-4">
									<ol className="space-y-3">
										{thread.messages.map((message) => (
											<li
												key={message.id}
												className={`rounded-lg p-3 text-sm ${
													message.side === 'support' ? 'bg-muted' : 'border'
												}`}
											>
												<p className="text-muted-foreground mb-1 text-xs">
													{message.authorName} ·{' '}
													{new Date(message.createdAt).toLocaleString()}
												</p>
												<p className="whitespace-pre-wrap">{message.body}</p>
											</li>
										))}
									</ol>
									<replyFetcher.Form
										method="post"
										ref={replyRef}
										className="space-y-2"
									>
										<input type="hidden" name="intent" value="reply" />
										<input type="hidden" name="requestId" value={thread.id} />
										<Textarea
											name="message"
											required
											maxLength={SUPPORT_MESSAGE_MAX}
											aria-label={_(msg`Your reply`)}
											placeholder={_(msg`Write a reply`)}
										/>
										{replyFetcher.data?.error ? (
											<p className="text-destructive text-sm" role="alert">
												<Trans>Write a message before sending.</Trans>
											</p>
										) : null}
										<Button
											type="submit"
											disabled={replyFetcher.state !== 'idle'}
										>
											<Trans>Send reply</Trans>
										</Button>
									</replyFetcher.Form>
								</CardContent>
							</Card>
						) : (
							<Card>
								<CardContent className="text-muted-foreground py-10 text-center">
									<Trans>Choose a request to read the thread.</Trans>
								</CardContent>
							</Card>
						)}
					</div>
				</div>
			)}
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
