import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserWithRole } from '@repo/auth'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Input } from '@repo/ui/input'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import {
	Form,
	Link,
	data,
	useActionData,
	useLoaderData,
	type ActionFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import {
	checkPhone,
	endAllSessions,
	lookupSignInHelp,
	resendSignInCode,
} from '#app/utils/sign-in-help.server.ts'

/**
 * Sign-in help (#246): "I did not get my code". Look an operator up by email or
 * phone, see each recent code attempt (when, channel, the provider's delivery
 * status and why it failed) and whether a number can receive texts. Support never
 * sees a code. History is the last 7 days.
 */
export async function loader({ request }: { request: Request }) {
	const agentId = await requireUserWithRole(request, 'admin')
	const q = new URL(request.url).searchParams.get('q')?.trim() ?? ''
	if (!q) return { q, result: null }
	const result = await lookupSignInHelp({ agentId, query: q, request })
	return {
		q,
		result:
			result.status === 'ok'
				? {
						...result,
						deliveries: result.deliveries.map((row) => ({
							...row,
							at: row.at.toISOString(),
							statusAt: row.statusAt.toISOString(),
						})),
						lastSent: result.lastSent
							? {
									...result.lastSent,
									at: result.lastSent.at.toISOString(),
									statusAt: result.lastSent.statusAt.toISOString(),
								}
							: null,
					}
				: result,
	}
}

const ActionSchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('check-phone'),
		phone: z.string().min(5).max(30),
	}),
	z.object({
		intent: z.literal('resend'),
		userId: z.string().min(1).max(64),
		channel: z.enum(['email', 'sms']),
	}),
	z.object({
		intent: z.literal('end-sessions'),
		userId: z.string().min(1).max(64),
	}),
])

export async function action({ request }: ActionFunctionArgs) {
	const agentId = await requireUserWithRole(request, 'admin')
	const parsed = ActionSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) throw data({ error: 'invalid' }, { status: 400 })
	const input = parsed.data
	if (input.intent === 'check-phone') {
		return data({
			intent: 'check-phone' as const,
			outcome: await checkPhone({ agentId, phone: input.phone, request }),
		})
	}
	if (input.intent === 'resend') {
		return data({
			intent: 'resend' as const,
			outcome: await resendSignInCode({
				agentId,
				userId: input.userId,
				channel: input.channel,
				request,
			}),
		})
	}
	return data({
		intent: 'end-sessions' as const,
		outcome: await endAllSessions({ agentId, userId: input.userId, request }),
	})
}

function statusVariant(status: string) {
	return status === 'delivered'
		? ('default' as const)
		: status === 'sent' || status === 'delayed'
			? ('secondary' as const)
			: ('destructive' as const)
}

export default function SignInHelpPage() {
	const { q, result } = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const { _ } = useLingui()
	const ok = result && 'operator' in result ? result : null
	const last = ok?.lastSent ?? null
	const otherChannel = last?.channel === 'sms' ? 'email' : 'sms'
	const activeSessions = ok?.operator?.activeSessions ?? 0
	const endedSessions =
		actionData?.intent === 'end-sessions' ? actionData.outcome.ended : 0

	return (
		<div className="space-y-6">
			<PageHeader
				title={<Trans>Sign-in help</Trans>}
				description={
					<Trans>
						See whether a sign-in code was sent and delivered. Codes are never
						shown here. Every lookup is logged with your name.
					</Trans>
				}
			/>
			<Form method="get" className="flex max-w-xl items-end gap-3">
				<div className="flex-1 space-y-1.5">
					<label htmlFor="signin-q" className="text-sm font-medium">
						<Trans>Email or phone</Trans>
					</label>
					<Input id="signin-q" name="q" defaultValue={q} autoComplete="off" />
				</div>
				<Button type="submit">
					<Trans>Look up</Trans>
				</Button>
			</Form>

			{result?.status === 'invalid' ? (
				<p className="text-destructive text-sm" role="alert">
					<Trans>Enter an email address or a phone number.</Trans>
				</p>
			) : null}

			{ok ? (
				<div className="space-y-6">
					<div className="rounded-lg border p-4 text-sm">
						{ok.operator ? (
							<p>
								<Link
									to={`/users/${ok.operator.id}`}
									className="font-medium underline"
								>
									{ok.operator.name || ok.operator.email}
								</Link>{' '}
								· {ok.operator.email} ·{' '}
								<Trans>{activeSessions} active sessions</Trans>
							</p>
						) : (
							<p className="text-muted-foreground">
								<Trans>No operator account matches this lookup.</Trans>
							</p>
						)}
						{last ? (
							<p className="mt-2" data-testid="last-code">
								<Trans>Last code</Trans>:{' '}
								<Badge variant={statusVariant(last.status)}>
									{last.status}
								</Badge>{' '}
								<span className="text-muted-foreground">
									{last.channel === 'sms' ? _(msg`text`) : _(msg`email`)} ·{' '}
									{last.destinationHint} · {new Date(last.at).toLocaleString()}
								</span>
								{last.failureReason ? (
									<span className="text-destructive">
										{' '}
										· {last.failureReason}
									</span>
								) : null}
							</p>
						) : (
							<p className="text-muted-foreground mt-2">
								<Trans>No code was sent in the last 7 days.</Trans>
							</p>
						)}
					</div>

					{ok.phone ? (
						<Form method="post" className="flex flex-wrap items-center gap-3">
							<input type="hidden" name="intent" value="check-phone" />
							<input type="hidden" name="phone" value={ok.phone} />
							<Button type="submit" variant="outline" size="sm">
								<Trans>Check this number</Trans>
							</Button>
							{actionData?.intent === 'check-phone' ? (
								actionData.outcome.status === 'ok' ? (
									<span className="text-sm">
										{actionData.outcome.problemText ? (
											<span className="text-destructive" role="alert">
												{actionData.outcome.problemText}
											</span>
										) : (
											<Trans>
												This is a mobile number that can receive texts.
											</Trans>
										)}{' '}
										<span className="text-muted-foreground">
											{actionData.outcome.check.lineType}
											{actionData.outcome.check.carrier
												? ` · ${actionData.outcome.check.carrier}`
												: ''}
										</span>
									</span>
								) : (
									<span className="text-muted-foreground text-sm">
										<Trans>The number could not be checked.</Trans>
									</span>
								)
							) : null}
						</Form>
					) : null}

					{ok.operator ? (
						<div className="flex flex-wrap items-center gap-3">
							<Form method="post">
								<input type="hidden" name="intent" value="resend" />
								<input type="hidden" name="userId" value={ok.operator.id} />
								<input type="hidden" name="channel" value={otherChannel} />
								<Button type="submit" variant="outline" size="sm">
									{otherChannel === 'sms' ? (
										<Trans>Resend a code by text</Trans>
									) : (
										<Trans>Resend a code by email</Trans>
									)}
								</Button>
							</Form>
							<Form method="post">
								<input type="hidden" name="intent" value="end-sessions" />
								<input type="hidden" name="userId" value={ok.operator.id} />
								<Button type="submit" variant="outline" size="sm">
									<Trans>End all sessions</Trans>
								</Button>
							</Form>
							{actionData?.intent === 'resend' ? (
								<span className="text-sm" role="status">
									{actionData.outcome.status === 'sent' ? (
										<Trans>A new code was sent.</Trans>
									) : actionData.outcome.status === 'no_phone_on_file' ? (
										<Trans>
											This operator has no verified phone number on file.
										</Trans>
									) : actionData.outcome.status === 'rate_limited' ? (
										<Trans>Too many codes were sent. Try again later.</Trans>
									) : (
										<Trans>The code could not be sent.</Trans>
									)}
								</span>
							) : null}
							{actionData?.intent === 'end-sessions' ? (
								<span className="text-sm" role="status">
									<Trans>{endedSessions} sessions ended.</Trans>
								</span>
							) : null}
						</div>
					) : null}

					{ok.deliveries.length > 0 ? (
						<Frame className="w-full">
							<Table variant="card">
								<TableHeader>
									<TableRow>
										<TableHead>
											<Trans>When</Trans>
										</TableHead>
										<TableHead>
											<Trans>Channel</Trans>
										</TableHead>
										<TableHead>
											<Trans>For</Trans>
										</TableHead>
										<TableHead>
											<Trans>Status</Trans>
										</TableHead>
										<TableHead>
											<Trans>Details</Trans>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{ok.deliveries.map((row) => (
										<TableRow key={row.id}>
											<TableCell className="text-sm">
												{new Date(row.at).toLocaleString()}
											</TableCell>
											<TableCell>
												{row.channel === 'sms' ? _(msg`Text`) : _(msg`Email`)}
												<div className="text-muted-foreground text-xs">
													{row.destinationHint}
												</div>
											</TableCell>
											<TableCell className="text-sm">
												{row.purpose.replace(/_/g, ' ')}
											</TableCell>
											<TableCell>
												<Badge variant={statusVariant(row.status)}>
													{row.status}
												</Badge>
											</TableCell>
											<TableCell className="text-sm whitespace-normal">
												{row.failureReason ? (
													<span className="text-destructive">
														{row.failureReason}
													</span>
												) : null}
												{row.problemText ? (
													<span className="text-destructive block">
														{row.problemText}
													</span>
												) : null}
												{row.lineType ? (
													<span className="text-muted-foreground block text-xs">
														{row.lineType}
														{row.carrier ? ` · ${row.carrier}` : ''}
													</span>
												) : null}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</Frame>
					) : null}
				</div>
			) : null}
		</div>
	)
}
