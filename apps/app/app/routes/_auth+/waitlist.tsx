import { Trans, Plural, t } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import { getPageTitle } from '@repo/config/brand'
import { db, eq, User } from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Field, FieldContent } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import {
	InputGroup,
	InputGroupInput,
	InputGroupAddon,
	InputGroupButton,
} from '@repo/ui/input-group'
import { Separator } from '@repo/ui/separator'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { redirect } from 'react-router'
import {
	getDiscordInviteUrl,
	getLaunchStatus,
	getWhatsAppGroupInviteUrl,
} from '#app/utils/env.server.ts'
import {
	getOrCreateWaitlistEntry,
	calculateUserRank,
} from '#app/utils/waitlist.server.ts'
import { type Route } from './+types/waitlist.ts'

const EASE_OUT = [0.16, 1, 0.3, 1] as const

export async function loader({ request }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const [user] = await db
		.select({ email: User.email, name: User.name })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)

	if (!user) {
		throw redirect('/login')
	}

	// If launch status is not CLOSED_BETA, redirect to organizations
	const launchStatus = getLaunchStatus()
	if (launchStatus !== 'CLOSED_BETA') {
		throw redirect('/organizations')
	}

	// Get or create waitlist entry
	const waitlistEntry = await getOrCreateWaitlistEntry(userId)

	// Calculate rank
	const { rank, totalUsers } = await calculateUserRank(userId)

	// Get the base URL for referral links
	const url = new URL(request.url)
	const baseUrl = `${url.protocol}//${url.host}`
	const referralUrl = `${baseUrl}/r/${waitlistEntry.referralCode}`
	const whatsappShareUrl = `https://wa.me/?text=${encodeURIComponent(
		`Join me on the waitlist: ${referralUrl}`,
	)}`

	// Get Discord configuration
	const discordInviteUrl = getDiscordInviteUrl()
	const whatsappGroupInviteUrl = getWhatsAppGroupInviteUrl()
	const hasDiscordOAuth =
		!!process.env.DISCORD_CLIENT_ID &&
		!!process.env.DISCORD_CLIENT_SECRET &&
		!!process.env.DISCORD_GUILD_ID

	return {
		user,
		waitlistEntry: {
			points: waitlistEntry.points,
			referralCode: waitlistEntry.referralCode,
			hasJoinedDiscord: waitlistEntry.hasJoinedDiscord,
			referralCount: waitlistEntry.referrals.length,
		},
		rank,
		totalUsers,
		referralUrl,
		whatsappShareUrl,
		discordInviteUrl,
		whatsappGroupInviteUrl,
		hasDiscordOAuth,
	}
}

export function meta() {
	return [{ title: getPageTitle('You are on the Waitlist') }]
}

function WaitlistStat({
	label,
	value,
	suffix,
	delay,
	shouldReduceMotion,
}: {
	label: ReactNode
	value: ReactNode
	suffix?: ReactNode
	delay: number
	shouldReduceMotion: boolean | null
}) {
	return (
		<motion.div
			className="flex flex-col items-center px-4 py-4 text-center"
			initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{
				delay,
				duration: shouldReduceMotion ? 0.15 : 0.35,
				ease: EASE_OUT,
			}}
		>
			<p className="text-muted-foreground mb-2 text-xs font-medium">{label}</p>
			<p className="text-foreground flex min-h-9 items-end justify-center text-3xl leading-none font-bold tabular-nums">
				{value}
			</p>
			<p className="text-muted-foreground mt-2 min-h-4 text-xs tabular-nums">
				{suffix ?? '\u00A0'}
			</p>
		</motion.div>
	)
}

function WaitlistActionRow({
	icon,
	title,
	badge,
	children,
	delay,
	shouldReduceMotion,
}: {
	icon: React.ComponentProps<typeof Icon>['name']
	title: ReactNode
	badge: ReactNode
	children: ReactNode
	delay: number
	shouldReduceMotion: boolean | null
}) {
	return (
		<motion.div
			className="flex items-start gap-3"
			initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{
				delay,
				duration: shouldReduceMotion ? 0.15 : 0.35,
				ease: EASE_OUT,
			}}
		>
			<div className="bg-primary/10 ring-primary/15 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1">
				<Icon name={icon} className="text-primary h-4 w-4" />
			</div>
			<div className="min-w-0 flex-1 space-y-2">
				<div className="flex flex-wrap items-baseline justify-between gap-2">
					<p className="text-sm font-medium">{title}</p>
					<Badge variant="secondary" className="shrink-0">
						{badge}
					</Badge>
				</div>
				{children}
			</div>
		</motion.div>
	)
}

export default function WaitlistPage({ loaderData }: Route.ComponentProps) {
	const {
		user,
		waitlistEntry,
		rank,
		totalUsers,
		referralUrl,
		whatsappShareUrl,
		discordInviteUrl,
		whatsappGroupInviteUrl,
		hasDiscordOAuth,
	} = loaderData
	const [copied, setCopied] = useState(false)
	const shouldReduceMotion = useReducedMotion()
	const userEmail = user.email
	const referralCount = waitlistEntry.referralCount
	const points = waitlistEntry.points

	useEffect(() => {
		if (!copied) return
		const timeoutId = setTimeout(() => setCopied(false), 2000)
		return () => clearTimeout(timeoutId)
	}, [copied])

	const copyToClipboard = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(referralUrl)
			setCopied(true)
		} catch (err) {
			console.error('Failed to copy:', err)
			// Fallback for browsers that don't support clipboard API
			const textArea = document.createElement('textarea')
			textArea.value = referralUrl
			document.body.appendChild(textArea)
			textArea.select()
			try {
				document.execCommand('copy')
				setCopied(true)
			} catch (fallbackErr) {
				console.error('Fallback copy failed:', fallbackErr)
			}
			document.body.removeChild(textArea)
		}
	}, [referralUrl])

	return (
		<motion.div
			initial={
				shouldReduceMotion
					? { opacity: 0 }
					: { opacity: 0, y: 20, filter: 'blur(6px)' }
			}
			animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
			transition={{
				duration: shouldReduceMotion ? 0.2 : 0.5,
				ease: EASE_OUT,
			}}
		>
			<Card className="bg-card/95 shadow-lg shadow-black/10 backdrop-blur-sm">
				<CardHeader className="space-y-4 text-center">
					<motion.div
						className="bg-primary/15 ring-primary/25 mx-auto flex h-14 w-14 items-center justify-center rounded-full ring-1"
						initial={
							shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85 }
						}
						animate={{ opacity: 1, scale: 1 }}
						transition={{
							delay: shouldReduceMotion ? 0 : 0.12,
							duration: shouldReduceMotion ? 0.15 : 0.4,
							ease: EASE_OUT,
						}}
					>
						<Icon name="check" className="text-primary h-7 w-7" />
					</motion.div>
					<div className="space-y-1.5">
						<CardTitle className="text-2xl font-bold text-balance">
							<Trans>You're on the Waitlist!</Trans>
						</CardTitle>
						<CardDescription className="text-base">
							<Trans>
								We'll notify you by email as soon as the waitlist opens.
							</Trans>
						</CardDescription>
					</div>
				</CardHeader>

				<CardContent className="space-y-6">
					<div>
						<p className="mb-1 text-center font-medium">
							<Trans>Want to go to the top of the waitlist?</Trans>
						</p>
						<p className="text-muted-foreground mb-4 text-center text-sm">
							<Trans>Here's how to do it:</Trans>
						</p>
						<div className="bg-muted/40 divide-border/70 grid grid-cols-2 divide-x rounded-xl border">
							<WaitlistStat
								label={<Trans>Your points</Trans>}
								value={points}
								delay={shouldReduceMotion ? 0 : 0.18}
								shouldReduceMotion={shouldReduceMotion}
							/>
							<WaitlistStat
								label={<Trans>Your rank</Trans>}
								value={`#${rank}`}
								suffix={<Trans>of {totalUsers} people</Trans>}
								delay={shouldReduceMotion ? 0 : 0.24}
								shouldReduceMotion={shouldReduceMotion}
							/>
						</div>
					</div>

					<Separator />

					<div className="space-y-5">
						<WaitlistActionRow
							icon="users"
							title={<Trans>Share with others</Trans>}
							badge={<Trans>+5 points/referral</Trans>}
							delay={shouldReduceMotion ? 0 : 0.3}
							shouldReduceMotion={shouldReduceMotion}
						>
							<Field>
								<FieldContent>
									<InputGroup>
										<InputGroupInput
											type="text"
											value={referralUrl}
											readOnly
											aria-label={t`Your referral link`}
										/>
										<InputGroupAddon align="inline-end">
											<InputGroupButton
												onClick={copyToClipboard}
												variant="ghost"
												size="xs"
												aria-live="polite"
											>
												<AnimatePresence mode="wait" initial={false}>
													<motion.span
														key={copied ? 'copied' : 'copy'}
														className="inline-flex items-center gap-1"
														initial={{ opacity: 0, y: 4 }}
														animate={{ opacity: 1, y: 0 }}
														exit={{ opacity: 0, y: -4 }}
														transition={{
															duration: shouldReduceMotion ? 0.1 : 0.15,
															ease: EASE_OUT,
														}}
													>
														<Icon name={copied ? 'check' : 'copy'} />
														{copied ? (
															<Trans>Copied!</Trans>
														) : (
															<Trans>Copy</Trans>
														)}
													</motion.span>
												</AnimatePresence>
											</InputGroupButton>
										</InputGroupAddon>
									</InputGroup>
								</FieldContent>
							</Field>
							<Button
								className="bg-primary text-primary-foreground hover:bg-chart-4 w-full"
								render={
									<a
										href={whatsappShareUrl}
										target="_blank"
										rel="noopener noreferrer"
									/>
								}
							>
								<Icon name="message-circle" className="mr-2 h-4 w-4" />
								<Trans>Share on WhatsApp</Trans>
							</Button>
							{referralCount > 0 && (
								<p className="text-primary text-xs font-medium">
									<Plural
										value={referralCount}
										one="# person joined using your link!"
										other="# people joined using your link!"
									/>{' '}
									<Trans>Thanks for referring.</Trans>
								</p>
							)}
						</WaitlistActionRow>

						<WaitlistActionRow
							icon="message-circle"
							title={<Trans>Join our Discord</Trans>}
							badge={<Trans>+2 points</Trans>}
							delay={shouldReduceMotion ? 0 : 0.36}
							shouldReduceMotion={shouldReduceMotion}
						>
							{waitlistEntry.hasJoinedDiscord ? (
								<p className="text-primary text-xs font-medium">
									<Trans>✓ Discord points claimed</Trans>
								</p>
							) : (
								<div className="flex flex-col gap-2">
									{discordInviteUrl && (
										<Button
											className="w-full bg-[#5865F2] text-white hover:bg-[#4752C4]"
											render={
												<a
													href={discordInviteUrl}
													target="_blank"
													rel="noopener noreferrer"
												/>
											}
										>
											<Trans>Join Discord server</Trans>
										</Button>
									)}
									{hasDiscordOAuth ? (
										<>
											<Button
												variant="outline"
												className="w-full border-[#5865F2] text-[#5865F2] hover:bg-[#5865F2]/10"
												render={<a href="/auth/discord/verify" />}
											>
												<Trans>Verify Discord membership</Trans>
											</Button>
											<p className="text-muted-foreground text-xs">
												<Trans>
													Click "Verify Discord membership" after joining to
													claim your points automatically.
												</Trans>
											</p>
										</>
									) : (
										<p className="text-muted-foreground text-xs">
											<Trans>
												Note: Discord verification is currently manual. Contact
												support after joining to claim your points.
											</Trans>
										</p>
									)}
								</div>
							)}
						</WaitlistActionRow>

						{whatsappGroupInviteUrl && (
							<WaitlistActionRow
								icon="message-circle"
								title={<Trans>Join our WhatsApp group</Trans>}
								badge={<Trans>Community</Trans>}
								delay={shouldReduceMotion ? 0 : 0.42}
								shouldReduceMotion={shouldReduceMotion}
							>
								<div className="flex flex-col gap-2">
									<Button
										className="bg-primary text-primary-foreground hover:bg-chart-4 w-full"
										render={
											<a
												href={whatsappGroupInviteUrl}
												target="_blank"
												rel="noopener noreferrer"
											/>
										}
									>
										<Icon name="message-circle" className="mr-2 h-4 w-4" />
										<Trans>Join WhatsApp group</Trans>
									</Button>
									<p className="text-muted-foreground text-xs">
										<Trans>
											Meet other members and share updates in the group. An
											admin can add community points after you join.
										</Trans>
									</p>
								</div>
							</WaitlistActionRow>
						)}
					</div>
				</CardContent>

				<CardFooter>
					<p className="text-muted-foreground text-sm">
						<Trans>
							We'll send you an email at{' '}
							<span className="font-semibold">{userEmail}</span> when we're
							ready to welcome you.
						</Trans>
					</p>
				</CardFooter>
			</Card>
		</motion.div>
	)
}
