import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
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
import { Badge } from '@repo/ui/badge'
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
import {
	Form,
	Link,
	redirect,
	useLoaderData,
	useNavigation,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { SOCIAL_PLATFORM_LABELS } from '#app/components/social/social-labels.ts'
import { SocialPlatformIcon } from '#app/components/social/social-ui.tsx'
import { requireSocialAccess } from '#app/utils/social/access.server.ts'
import {
	deleteSocialAccount,
	listSocialAccounts,
	saveSocialAccounts,
} from '#app/utils/social/accounts.server.ts'
import { isMetaConfigured, isSocialMock } from '#app/utils/social/env.server.ts'
import {
	exchangeMetaCode,
	listMetaAccounts,
	metaAuthorizeUrl,
} from '#app/utils/social/meta.server.ts'
import {
	newOAuthState,
	setMetaOAuthState,
} from '#app/utils/social/oauth-state.server.ts'
import {
	SOCIAL_PLATFORMS,
	isSocialPlatform,
	type SocialPlatform,
} from '#app/utils/social/platforms.ts'

const ActionSchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('connect'),
		platform: z.enum(SOCIAL_PLATFORMS),
	}),
	z.object({ intent: z.literal('disconnect'), accountId: z.string().max(64) }),
])

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireSocialAccess(request, params.orgSlug)
	const { timeZone } = getHints(request)
	const url = new URL(request.url)
	const connected = url.searchParams.get('connected')
	const platform = url.searchParams.get('platform')
	const meta = url.searchParams.get('meta')
	return {
		orgSlug: access.organization.slug,
		canWrite: access.canWrite,
		timeZone,
		configured: isMetaConfigured(),
		mock: isSocialMock(),
		accounts: await listSocialAccounts(access.organization.id),
		notice: isSocialPlatform(connected)
			? ({ kind: 'connected', platform: connected } as const)
			: meta === 'none' && isSocialPlatform(platform)
				? ({ kind: 'none', platform } as const)
				: meta === 'denied' || meta === 'failed'
					? ({ kind: meta } as const)
					: null,
	}
}

/**
 * Connecting starts only from a POST here (the session cookie is
 * SameSite=Lax, so another site cannot post as the member). Facebook sends
 * the member back to `/resources/social/meta/callback`. The local emulator
 * connects at once.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	const access = await requireSocialAccess(request, params.orgSlug, {
		write: true,
	})
	const parsed = ActionSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) throw new Response('Bad Request', { status: 400 })
	const back = `/${access.organization.slug}/marketing/social/accounts`

	if (parsed.data.intent === 'disconnect') {
		const deleted = await deleteSocialAccount(
			access.organization.id,
			parsed.data.accountId,
		)
		if (!deleted) throw new Response('Not Found', { status: 404 })
		return redirect(back)
	}

	if (!isMetaConfigured()) throw new Response('Not Found', { status: 404 })
	const platform = parsed.data.platform
	if (isSocialMock()) {
		const token = await exchangeMetaCode('mock')
		await saveSocialAccounts(access, await listMetaAccounts(token, platform))
		return redirect(`${back}?connected=${platform}`)
	}
	const state = newOAuthState()
	return redirect(metaAuthorizeUrl({ state, platform }), {
		headers: {
			'Set-Cookie': await setMetaOAuthState({
				state,
				platform,
				userId: access.userId,
				orgSlug: access.organization.slug,
			}),
		},
	})
}

const PLATFORM_DESCRIPTIONS: Record<SocialPlatform, MessageDescriptor> = {
	facebook: msg`Post to the Facebook Pages you manage.`,
	instagram: msg`Post to Instagram professional accounts (business or creator) linked to a Facebook Page.`,
}

export default function SocialAccountsRoute() {
	const { _, i18n } = useLingui()
	const { orgSlug, canWrite, timeZone, configured, mock, accounts, notice } =
		useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const connecting =
		navigation.state !== 'idle' &&
		navigation.formData?.get('intent') === 'connect'
			? navigation.formData.get('platform')
			: null
	const connectedOn = new Intl.DateTimeFormat(i18n.locale, {
		dateStyle: 'medium',
		timeZone,
	})

	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Social accounts`)}
				description={_(
					msg`Accounts connected here are shared with everyone in the organization who can manage marketing.`,
				)}
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

			{notice?.kind === 'connected' ? (
				<Alert>
					<Icon name="circle-check" />
					<AlertTitle>
						{(() => {
							const platformName = _(SOCIAL_PLATFORM_LABELS[notice.platform])
							return _(msg`${platformName} connected`)
						})()}
					</AlertTitle>
				</Alert>
			) : notice?.kind === 'none' ? (
				<Alert variant="destructive">
					<Icon name="circle-alert" />
					<AlertTitle>
						{notice.platform === 'instagram'
							? _(msg`No Instagram professional account found`)
							: _(msg`No Facebook Page found`)}
					</AlertTitle>
					<AlertDescription>
						{notice.platform === 'instagram'
							? _(
									msg`Switch the Instagram account to a business or creator account, link it to a Facebook Page, and allow that Page when Facebook asks.`,
								)
							: _(msg`Allow at least one Page you manage when Facebook asks.`)}
					</AlertDescription>
				</Alert>
			) : notice?.kind === 'denied' ? (
				<Alert>
					<Icon name="info" />
					<AlertTitle>{_(msg`Nothing was connected`)}</AlertTitle>
					<AlertDescription>
						{_(msg`The connection was cancelled in Facebook.`)}
					</AlertDescription>
				</Alert>
			) : notice?.kind === 'failed' ? (
				<Alert variant="destructive">
					<Icon name="circle-alert" />
					<AlertTitle>{_(msg`The connection failed`)}</AlertTitle>
					<AlertDescription>
						{_(msg`Meta did not complete the connection. Try again.`)}
					</AlertDescription>
				</Alert>
			) : null}

			{!configured ? (
				<Alert>
					<Icon name="info" />
					<AlertTitle>
						{_(msg`Connecting accounts is not available yet`)}
					</AlertTitle>
					<AlertDescription>
						{_(
							msg`This server has no Meta app configured. Ask your platform administrator.`,
						)}
					</AlertDescription>
				</Alert>
			) : mock ? (
				<Alert>
					<Icon name="info" />
					<AlertTitle>{_(msg`Local emulator`)}</AlertTitle>
					<AlertDescription>
						{_(
							msg`Connecting adds a sample account and nothing is really posted. A post containing #fail is refused, to try the retry path.`,
						)}
					</AlertDescription>
				</Alert>
			) : null}

			{SOCIAL_PLATFORMS.map((platform) => {
				const platformAccounts = accounts.filter(
					(account) => account.platform === platform,
				)
				const platformName = _(SOCIAL_PLATFORM_LABELS[platform])
				return (
					<section
						key={platform}
						aria-labelledby={`social-${platform}-heading`}
						className="space-y-3"
					>
						<div className="flex flex-wrap items-start justify-between gap-4">
							<div className="flex items-start gap-3">
								<SocialPlatformIcon
									platform={platform}
									className="mt-0.5 size-5"
								/>
								<div>
									<h2 id={`social-${platform}-heading`} className="font-medium">
										{platformName}
									</h2>
									<p className="text-muted-foreground text-sm">
										{_(PLATFORM_DESCRIPTIONS[platform])}
									</p>
								</div>
							</div>
							{canWrite && configured ? (
								<Form method="post">
									<input type="hidden" name="platform" value={platform} />
									<Button
										type="submit"
										name="intent"
										value="connect"
										variant={
											platformAccounts.length > 0 ? 'outline' : 'default'
										}
										disabled={connecting != null}
									>
										<Icon name={connecting === platform ? 'loader' : 'plus'} />
										{platformAccounts.length > 0
											? _(msg`Add or refresh accounts`)
											: _(msg`Connect ${platformName}`)}
									</Button>
								</Form>
							) : null}
						</div>

						{platformAccounts.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								{_(msg`No accounts connected.`)}
							</p>
						) : (
							<ItemGroup>
								{platformAccounts.map((account) => {
									const accountName = account.name
									return (
										<Item key={account.id} variant="outline" size="sm">
											<ItemMedia variant="icon">
												<SocialPlatformIcon platform={account.platform} />
											</ItemMedia>
											<ItemContent>
												<ItemTitle className="wrap-anywhere">
													{account.name}
												</ItemTitle>
												<ItemDescription>
													{account.username ? `@${account.username} · ` : ''}
													{(() => {
														const date = connectedOn.format(
															new Date(account.createdAt),
														)
														return _(msg`Connected ${date}`)
													})()}
												</ItemDescription>
											</ItemContent>
											<ItemActions>
												{account.status === 'needs_reauth' ? (
													<Badge variant="warning">
														{_(msg`Reconnect needed`)}
													</Badge>
												) : (
													<Badge variant="success">{_(msg`Active`)}</Badge>
												)}
												{canWrite ? (
													<AlertDialog>
														<AlertDialogTrigger
															render={
																<Button variant="ghost" size="sm">
																	{_(msg`Disconnect`)}
																</Button>
															}
														/>
														<AlertDialogContent>
															<AlertDialogHeader>
																<AlertDialogTitle>
																	{_(msg`Disconnect ${accountName}?`)}
																</AlertDialogTitle>
																<AlertDialogDescription>
																	{_(
																		msg`Posts already sent stay on ${platformName}. Scheduled posts will fail for this account.`,
																	)}
																</AlertDialogDescription>
															</AlertDialogHeader>
															<AlertDialogFooter>
																<AlertDialogCancel>
																	{_(msg`Keep it`)}
																</AlertDialogCancel>
																<Form method="post">
																	<input
																		type="hidden"
																		name="accountId"
																		value={account.id}
																	/>
																	<Button
																		type="submit"
																		name="intent"
																		value="disconnect"
																		variant="destructive"
																	>
																		{_(msg`Disconnect`)}
																	</Button>
																</Form>
															</AlertDialogFooter>
														</AlertDialogContent>
													</AlertDialog>
												) : null}
											</ItemActions>
										</Item>
									)
								})}
							</ItemGroup>
						)}
					</section>
				)
			})}
		</div>
	)
}
