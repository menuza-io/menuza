import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

/**
 * The public link to a posting, with a button to copy it and a QR code to
 * print for the window or the counter. The QR is drawn in the browser from the
 * link; nothing is sent anywhere.
 */
export function JobSharePanel({
	url,
	fileName,
}: {
	url: string
	fileName: string
}) {
	const { _ } = useLingui()
	const [qr, setQr] = useState<string | null>(null)

	useEffect(() => {
		let cancelled = false
		void import('qrcode')
			.then((module) =>
				module.toDataURL(url, {
					margin: 2,
					width: 480,
					errorCorrectionLevel: 'M',
					// A printed code needs real black on white to scan, in dark mode too.
					color: { dark: '#000000', light: '#ffffff' },
				}),
			)
			.then((dataUrl) => {
				if (!cancelled) setQr(dataUrl)
			})
			.catch(() => {
				if (!cancelled) setQr(null)
			})
		return () => {
			cancelled = true
		}
	}, [url])

	async function copy() {
		try {
			await navigator.clipboard.writeText(url)
			toast.success(_(t`Link copied.`))
		} catch {
			toast.error(_(t`Could not copy. Select the link and copy it by hand.`))
		}
	}

	return (
		<div className="flex flex-col gap-4 sm:flex-row sm:items-start">
			{qr ? (
				<img
					src={qr}
					alt={_(t`QR code that opens this job`)}
					width={160}
					height={160}
					className="size-40 shrink-0 rounded-lg border"
				/>
			) : (
				<div
					aria-hidden="true"
					className="bg-muted size-40 shrink-0 rounded-lg"
				/>
			)}
			<div className="flex min-w-0 flex-col gap-3">
				<p className="text-muted-foreground text-sm">
					<Trans>Anyone with this link can see the job and apply.</Trans>
				</p>
				<a
					href={url}
					target="_blank"
					rel="noopener noreferrer"
					dir="ltr"
					className="text-foreground focus-visible:ring-ring/50 rounded-sm text-sm break-all underline underline-offset-4 outline-none focus-visible:ring-3"
				>
					{url}
				</a>
				<div className="flex flex-wrap gap-2">
					<Button type="button" variant="outline" onClick={copy}>
						<Icon name="copy" />
						<Trans>Copy link</Trans>
					</Button>
					{qr ? (
						<Button
							variant="outline"
							render={<a href={qr} download={`${fileName}-qr.png`} />}
						>
							<Icon name="download" />
							<Trans>Download QR code</Trans>
						</Button>
					) : null}
				</div>
			</div>
		</div>
	)
}
