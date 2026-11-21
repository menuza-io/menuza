import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CouponOfferField, type CouponOfferValue } from '@repo/marketing'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useEffect, useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { toast } from 'sonner'
import { type CouponDiscountOption } from '#app/utils/discounts/marketing-offers.server.ts'
import { type ProgramCardData } from '#app/utils/marketing/programs.server.ts'

/**
 * Ready-made programs (#100): cards above the automations list. Turn on creates
 * and publishes the program from its template in the organization's branding
 * and language; Customize opens the editor first. Nothing is on by default.
 */
export function ProgramsSection({
	orgSlug,
	programs,
	couponOptions,
	canManage,
}: {
	orgSlug: string
	programs: ProgramCardData[]
	couponOptions: CouponDiscountOption[] | null
	canManage: boolean
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{
		ok?: boolean
		error?: string
		journeyId?: string
		intent?: string
	}>()
	const [choosing, setChoosing] = useState<{
		program: ProgramCardData
		customize: boolean
	} | null>(null)
	const [channel, setChannel] = useState<'email' | 'sms'>('email')
	const [coupon, setCoupon] = useState<CouponOfferValue | null>(null)
	const [reviewUrl, setReviewUrl] = useState('')

	const statusText = {
		off: _(msg`Off`),
		on: _(msg`On`),
		customized: _(msg`Customized`),
		paused: _(msg`Paused`),
	} as const

	useEffect(() => {
		if (fetcher.state !== 'idle' || !fetcher.data) return
		if (fetcher.data.ok) {
			toast.success(_(msg`Program set up`))
			setChoosing(null)
		} else if (fetcher.data.error) {
			toast.error(fetcher.data.error)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fetcher.state, fetcher.data])

	if (programs.length === 0) return null

	const submit = (customize: boolean) => {
		if (!choosing) return
		void fetcher.submit(
			{
				intent: customize ? 'program_customize' : 'program_turn_on',
				programId: choosing.program.id,
				channel,
				discountOffer: coupon ? JSON.stringify(coupon) : '',
				reviewUrl,
			},
			{ method: 'POST' },
		)
	}

	return (
		<section className="space-y-3">
			<div>
				<h2 className="text-base font-semibold">
					<Trans>Programs</Trans>
				</h2>
				<p className="text-muted-foreground text-sm">
					<Trans>
						Ready-made automations. Turn one on and it starts for new guests
						only; you can change it any time.
					</Trans>
				</p>
			</div>

			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{programs.map((program) => (
					<div
						key={program.id}
						className="bg-card flex flex-col justify-between gap-3 rounded-lg border p-4"
					>
						<div className="space-y-2">
							<div className="flex items-start justify-between gap-2">
								<h3 className="text-sm font-medium">{program.name}</h3>
								<Badge
									variant="outline"
									className={cn(
										'shrink-0 text-[10px]',
										program.status === 'on' &&
											'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
										program.status === 'customized' &&
											'border-chart-5/30 bg-chart-5/10 text-chart-5',
										program.status === 'paused' &&
											'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
									)}
								>
									{statusText[program.status]}
								</Badge>
							</div>
							<p className="text-muted-foreground text-xs">{program.summary}</p>
							<p className="text-muted-foreground text-[11px]">
								{program.channels
									.map((c) => (c === 'email' ? _(msg`Email`) : _(msg`Text`)))
									.join(' · ')}
							</p>
							{program.results ? (
								<ProgramResults results={program.results} />
							) : null}
							{program.newerTemplate ? (
								<p className="text-muted-foreground text-[11px]">
									<Trans>
										A newer version of this program exists. Yours keeps working
										as it is.
									</Trans>
								</p>
							) : null}
						</div>

						{canManage ? (
							<div className="flex gap-2">
								{program.journeyId ? (
									<Button
										size="sm"
										variant="outline"
										render={
											<Link
												to={`/${orgSlug}/marketing/automations/${program.journeyId}`}
											/>
										}
									>
										<Trans>Open</Trans>
									</Button>
								) : (
									<>
										<Button
											size="sm"
											onClick={() => {
												setChannel('email')
												setCoupon(null)
												setReviewUrl('')
												setChoosing({ program, customize: false })
											}}
										>
											<Trans>Turn on</Trans>
										</Button>
										<Button
											size="sm"
											variant="outline"
											onClick={() => {
												setChannel('email')
												setCoupon(null)
												setReviewUrl('')
												setChoosing({ program, customize: true })
											}}
										>
											<Trans>Customize</Trans>
										</Button>
									</>
								)}
							</div>
						) : null}
					</div>
				))}
			</div>

			<Dialog
				open={choosing !== null}
				onOpenChange={(open) => !open && setChoosing(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{choosing?.program.name}</DialogTitle>
						<DialogDescription>
							{choosing?.customize
								? _(msg`Choose how it starts, then adjust it in the editor.`)
								: _(msg`Choose how it starts. It is turned on right away.`)}
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						{choosing && choosing.program.channels.length > 1 ? (
							<div className="space-y-1.5">
								<Label>
									<Trans>Send by</Trans>
								</Label>
								<div className="flex gap-2">
									{choosing.program.channels.map((c) => (
										<Button
											key={c}
											type="button"
											size="sm"
											variant={channel === c ? 'default' : 'outline'}
											onClick={() => setChannel(c)}
										>
											{c === 'email' ? _(msg`Email`) : _(msg`Text`)}
										</Button>
									))}
								</div>
							</div>
						) : null}

						{choosing?.program.coupon === 'optional' && couponOptions ? (
							<CouponOfferField
								options={couponOptions}
								value={coupon}
								onChange={setCoupon}
							/>
						) : null}

						{choosing?.program.needsReviewLink ? (
							<div className="space-y-1.5">
								<Label htmlFor="review-url">
									<Trans>Link to your Google review page</Trans>
								</Label>
								<Input
									id="review-url"
									type="url"
									inputMode="url"
									placeholder="https://"
									value={reviewUrl}
									onChange={(event) => setReviewUrl(event.target.value)}
								/>
							</div>
						) : null}

						<p className="text-muted-foreground text-xs">
							<Trans>
								Guests only get messages if they agreed to hear from you. The
								message is written in your website's language and uses your
								branding.
							</Trans>
						</p>
					</div>

					<DialogFooter>
						<Button variant="outline" onClick={() => setChoosing(null)}>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							disabled={fetcher.state !== 'idle'}
							onClick={() => submit(choosing?.customize ?? false)}
						>
							{choosing?.customize ? (
								<Trans>Create and customize</Trans>
							) : (
								<Trans>Turn on</Trans>
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	)
}

function ProgramResults({
	results,
}: {
	results: { runs: number; messagesSent: number; ordersByGoal: number }
}) {
	const { _ } = useLingui()
	const { runs, messagesSent, ordersByGoal } = results
	return (
		<p className="text-xs">
			{_(
				msg`Last 30 days: ${runs} runs · ${messagesSent} messages sent · ${ordersByGoal} orders`,
			)}
		</p>
	)
}
