import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { shortLinkUrl } from '@repo/common/short-links'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import QRCode from 'qrcode'
import { useState } from 'react'
import { useFetcher } from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { type ShortLinkRow } from '#app/utils/marketing/short-links.server.ts'

/** Pages a link may point at, as one tap; anything else is typed as a path. */
const QUICK_PATHS = ['/', '/menu', '/reserve', '/events'] as const

/** The last 30 days as thin bars, oldest to the left, scaled to the busiest day. */
export function ClickBars({
	daily,
	label,
}: {
	daily: ShortLinkRow['daily']
	label: string
}) {
	const peak = Math.max(1, ...daily.map((day) => day.clicks))
	return (
		<div
			role="img"
			aria-label={label}
			title={label}
			dir="ltr"
			className="flex h-8 w-40 items-end gap-px"
			data-testid="click-bars"
		>
			{daily.map((day) => (
				<span
					key={day.day}
					className="bg-primary/40 min-w-0 flex-1 rounded-t-xs"
					// A bar's height is data, with a pixel minimum so a quiet day shows.
					style={{
						height:
							day.clicks > 0
								? `${Math.max((day.clicks / peak) * 100, 8)}%`
								: '1px',
					}}
				/>
			))}
		</div>
	)
}

async function downloadQr(url: string, name: string) {
	const dataUrl = await QRCode.toDataURL(url, { margin: 2, width: 768 })
	const link = document.createElement('a')
	link.href = dataUrl
	link.download = `${name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'link'}-qr.png`
	link.click()
}

function LinkRow({
	link,
	siteOrigin,
	canWrite,
}: {
	link: ShortLinkRow
	siteOrigin: string
	canWrite: boolean
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher()
	const url = shortLinkUrl(siteOrigin, link.code)
	const total = link.daily.reduce((sum, day) => sum + day.clicks, 0)
	const title = link.label || link.targetPath
	return (
		<li
			className="flex flex-wrap items-center gap-x-6 gap-y-3 py-4"
			data-testid={`short-link-${link.code}`}
		>
			<div className="min-w-0 flex-1 basis-64 space-y-1">
				<p className="text-sm font-medium wrap-anywhere">{title}</p>
				<p className="text-muted-foreground text-sm wrap-anywhere" dir="ltr">
					{url}
				</p>
				<p className="text-muted-foreground text-xs wrap-anywhere" dir="ltr">
					{link.targetPath}
				</p>
			</div>
			<div className="space-y-1">
				<ClickBars
					daily={link.daily}
					label={_(msg`${total} clicks in the last 30 days`)}
				/>
				<p
					className="text-muted-foreground text-xs"
					data-testid="short-link-clicks"
				>
					{_(msg`Clicks: ${link.clicksThisMonth} this month`)}
				</p>
			</div>
			<div className="flex items-center gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => {
						void navigator.clipboard
							?.writeText(url)
							.then(() => toast.success(_(msg`Link copied`)))
							.catch(() => toast.error(_(msg`The link could not be copied`)))
					}}
				>
					<Icon name="copy" />
					{_(msg`Copy`)}
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => {
						void downloadQr(url, title).catch(() =>
							toast.error(_(msg`The QR code could not be made`)),
						)
					}}
				>
					<Icon name="download" />
					{_(msg`QR code`)}
				</Button>
				{canWrite ? (
					<Label className="flex items-center gap-2 text-sm">
						<Switch
							checked={!link.disabled}
							disabled={fetcher.state !== 'idle'}
							aria-label={_(msg`Link is on`)}
							onCheckedChange={(on) =>
								fetcher.submit(
									{ intent: on ? 'enable' : 'disable', id: link.id },
									{ method: 'post' },
								)
							}
						/>
						{link.disabled ? _(msg`Off`) : _(msg`On`)}
					</Label>
				) : null}
			</div>
		</li>
	)
}

export function ShortLinksScreen({
	links,
	siteOrigin,
	canWrite,
	error,
}: {
	links: ShortLinkRow[]
	siteOrigin: string
	canWrite: boolean
	error: string | null
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ error?: string; ok?: boolean }>()
	const [path, setPath] = useState('/menu')
	const busy = fetcher.state !== 'idle'
	return (
		<div className="space-y-8">
			{canWrite ? (
				<fetcher.Form
					method="post"
					className="space-y-4 rounded-lg border p-4"
					onSubmit={() => undefined}
				>
					<input type="hidden" name="intent" value="create" />
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="link-label">{_(msg`Name`)}</Label>
							<Input
								id="link-label"
								name="label"
								maxLength={120}
								placeholder={_(msg`Window sticker`)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="link-path">{_(msg`Page on your website`)}</Label>
							<Input
								id="link-path"
								name="targetPath"
								dir="ltr"
								value={path}
								onChange={(event) => setPath(event.target.value)}
								placeholder="/menu"
								required
							/>
							<div className="flex flex-wrap gap-2">
								{QUICK_PATHS.map((quick) => (
									<Button
										key={quick}
										type="button"
										variant={path === quick ? 'secondary' : 'outline'}
										size="xs"
										onClick={() => setPath(quick)}
									>
										{quick}
									</Button>
								))}
							</div>
						</div>
						<div className="space-y-2">
							<Label htmlFor="link-source">
								{_(msg`UTM source (optional)`)}
							</Label>
							<Input
								id="link-source"
								name="utmSource"
								dir="ltr"
								maxLength={100}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="link-campaign">
								{_(msg`UTM campaign (optional)`)}
							</Label>
							<Input
								id="link-campaign"
								name="utmCampaign"
								dir="ltr"
								maxLength={100}
							/>
						</div>
					</div>
					<p className="text-muted-foreground text-sm">
						{_(
							msg`Links only point to pages on your own website. A click is counted per day; we never keep who clicked.`,
						)}
					</p>
					{fetcher.data?.error ? (
						<p role="alert" className="text-destructive text-sm">
							{fetcher.data.error}
						</p>
					) : null}
					<Button type="submit" disabled={busy}>
						{_(msg`Create short link`)}
					</Button>
				</fetcher.Form>
			) : null}

			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : links.length === 0 ? (
				<EmptyState
					icons={['link-2']}
					title={_(msg`No short links yet`)}
					description={_(
						msg`Make a short link for a sticker, a flyer or a text, then see how many people use it.`,
					)}
				/>
			) : (
				<ul className="divide-y">
					{links.map((link) => (
						<LinkRow
							key={link.id}
							link={link}
							siteOrigin={siteOrigin}
							canWrite={canWrite}
						/>
					))}
				</ul>
			)}
		</div>
	)
}
