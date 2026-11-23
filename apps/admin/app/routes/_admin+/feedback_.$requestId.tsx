import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserWithRole } from '@repo/auth'
import {
	SUPPORT_MESSAGE_MAX,
	SUPPORT_STATUS_LABELS,
	replySchema,
} from '@repo/common/support-requests'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Textarea } from '@repo/ui/textarea'
import {
	Link,
	data,
	useFetcher,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import {
	getRequestThread,
	replyToRequest,
	setRequestStatus,
} from '#app/utils/support-requests.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserWithRole(request, 'admin')
	const thread = await getRequestThread(params.requestId ?? '', {
		markRead: true,
	})
	if (!thread || thread.kind === 'feedback') {
		throw new Response('Not found', { status: 404 })
	}
	return {
		thread: {
			...thread,
			messages: thread.messages.map((message) => ({
				...message,
				createdAt: message.createdAt.toISOString(),
			})),
		},
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const agentId = await requireUserWithRole(request, 'admin')
	const requestId = params.requestId ?? ''
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')

	if (intent === 'reply') {
		const parsed = replySchema.safeParse({ message: form.get('message') })
		if (!parsed.success) {
			return data(
				{ ok: false as const, error: 'invalid' as const },
				{ status: 400 },
			)
		}
		const result = await replyToRequest({
			agentId,
			requestId,
			body: parsed.data.message,
			request,
		})
		if (result.status !== 'replied') {
			throw new Response('Not found', { status: 404 })
		}
		return data({ ok: true as const, notified: result.notified })
	}
	if (intent === 'close' || intent === 'reopen') {
		const result = await setRequestStatus({
			agentId,
			requestId,
			status: intent === 'close' ? 'closed' : 'open',
			request,
		})
		if (result === 'not_found') throw new Response('Not found', { status: 404 })
		return data({ ok: true as const })
	}
	throw data({ error: 'invalid_intent' }, { status: 400 })
}

export default function AdminRequestPage() {
	const { thread } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const replyFetcher = useFetcher<{ ok?: boolean; error?: string }>()
	const statusFetcher = useFetcher()
	const context = thread.context

	return (
		<div className="mx-auto w-full max-w-4xl space-y-6">
			<div>
				<Link
					to="/feedback"
					className="text-muted-foreground text-sm hover:underline"
				>
					<Trans>Back to feedback and support</Trans>
				</Link>
				<div className="mt-2 flex flex-wrap items-center justify-between gap-3">
					<h1 className="text-2xl font-bold">
						{thread.subject || _(msg`Support request`)}
					</h1>
					<div className="flex items-center gap-2">
						<Badge variant="outline">{thread.kind}</Badge>
						<Badge>{SUPPORT_STATUS_LABELS[thread.status]}</Badge>
						<statusFetcher.Form method="post">
							<input
								type="hidden"
								name="intent"
								value={thread.status === 'closed' ? 'reopen' : 'close'}
							/>
							<Button
								type="submit"
								variant="outline"
								size="sm"
								disabled={statusFetcher.state !== 'idle'}
							>
								{thread.status === 'closed' ? (
									<Trans>Reopen</Trans>
								) : (
									<Trans>Close request</Trans>
								)}
							</Button>
						</statusFetcher.Form>
					</div>
				</div>
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">
						<Trans>Context</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="grid gap-2 text-sm sm:grid-cols-2">
						<div>
							<span className="text-muted-foreground">
								<Trans>Restaurant</Trans>:{' '}
							</span>
							<Link
								to={`/organizations/${thread.organization.id}`}
								className="font-medium hover:underline"
							>
								{thread.organization.name}
							</Link>
						</div>
						<div>
							<span className="text-muted-foreground">
								<Trans>From</Trans>:{' '}
							</span>
							<Link
								to={`/users/${thread.sender.id}`}
								className="hover:underline"
							>
								{thread.sender.name || thread.sender.email}
							</Link>
						</div>
						{context.path ? (
							<div>
								<span className="text-muted-foreground">
									<Trans>Page</Trans>:{' '}
								</span>
								<code>{context.path}</code>
							</div>
						) : null}
						{context.locationId ? (
							<div>
								<span className="text-muted-foreground">
									<Trans>Location</Trans>:{' '}
								</span>
								<code>{context.locationId}</code>
							</div>
						) : null}
						{context.appVersion ? (
							<div>
								<span className="text-muted-foreground">
									<Trans>Version</Trans>:{' '}
								</span>
								<code>{context.appVersion}</code>
							</div>
						) : null}
						{thread.errorId ? (
							<div>
								<span className="text-muted-foreground">
									<Trans>Error reference</Trans>:{' '}
								</span>
								<Link
									to={`/request-lookup?id=${thread.errorId}`}
									className="font-mono hover:underline"
								>
									{thread.errorId}
								</Link>
							</div>
						) : null}
						{thread.assigneeName ? (
							<div>
								<span className="text-muted-foreground">
									<Trans>Routed to</Trans>:{' '}
								</span>
								{thread.assigneeName}
							</div>
						) : null}
						{thread.hasScreenshot ? (
							<div>
								<a
									href={`/feedback/${thread.id}/screenshot`}
									target="_blank"
									rel="noreferrer"
									className="underline"
								>
									<Trans>Open the screenshot</Trans>
								</a>
							</div>
						) : null}
					</div>
				</CardContent>
			</Card>

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

			<replyFetcher.Form method="post" className="space-y-2">
				<input type="hidden" name="intent" value="reply" />
				<Textarea
					name="message"
					required
					maxLength={SUPPORT_MESSAGE_MAX}
					aria-label={_(msg`Your reply`)}
					placeholder={_(msg`Write a reply`)}
				/>
				{replyFetcher.data?.ok === true ? (
					<p className="text-muted-foreground text-sm">
						<Trans>Sent. The restaurant has been told.</Trans>
					</p>
				) : null}
				<Button type="submit" disabled={replyFetcher.state !== 'idle'}>
					<Trans>Send reply</Trans>
				</Button>
			</replyFetcher.Form>
		</div>
	)
}
