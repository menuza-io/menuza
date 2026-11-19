/**
 * The dialog that asks an organization's owners to accept a new version of a
 * Menuza agreement (#194, #89): what changed, a link to the full text, "I
 * agree". Before the version's "required by" date it can be postponed for the
 * session; after it the dashboard is blocked until it is accepted. Members who
 * are not owners never see it, and a support session cannot accept for the
 * owner.
 */
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { parseLocalizedString, pickLocalized } from '@repo/common/site-locales'
import { getBrandDomain } from '@repo/config/brand'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Spinner } from '@repo/ui/spinner'
import { useEffect, useMemo, useState } from 'react'
import { useFetcher, useRevalidator } from 'react-router'

export type PendingAgreementView = {
	key: string
	version: number
	title: string
	url: string
	summary: string | null
	scope: string
	requiredBy: string | null
	overdue: boolean
}

/** "version 2" (a message of its own, so the number is a plain variable). */
export function VersionLabel({ version }: { version: number }) {
	return <Trans>version {version}</Trans>
}

/** A relative address is a page of the marketing site. */
export function agreementHref(url: string) {
	return /^https?:\/\//iu.test(url) ? url : `https://${getBrandDomain()}${url}`
}

export function agreementText(raw: string | null, locale: string): string {
	if (!raw) return ''
	return pickLocalized(parseLocalizedString(raw, 'en'), locale, 'en') || ''
}

const postponedKey = (agreements: PendingAgreementView[]) =>
	`agreements-postponed:${agreements.map((a) => `${a.key}:${a.version}`).join(',')}`

export function AgreementDialog({
	orgSlug,
	pending,
	blocking,
	canAccept,
}: {
	orgSlug: string
	pending: PendingAgreementView[]
	blocking: boolean
	canAccept: boolean
}) {
	const { _, i18n } = useLingui()
	const fetcher = useFetcher<{ status?: string; error?: string }>()
	const revalidator = useRevalidator()
	const [postponed, setPostponed] = useState(true)
	const storageKey = useMemo(() => postponedKey(pending), [pending])

	useEffect(() => {
		if (pending.length === 0) return
		try {
			setPostponed(
				!blocking && window.sessionStorage.getItem(storageKey) === '1',
			)
		} catch {
			setPostponed(false)
		}
	}, [pending.length, blocking, storageKey])

	useEffect(() => {
		if (fetcher.state === 'idle' && fetcher.data?.status === 'success') {
			void revalidator.revalidate()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fetcher.state, fetcher.data])

	if (pending.length === 0) return null
	const busy = fetcher.state !== 'idle'
	const error = fetcher.data?.error
	const open = blocking || !postponed

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next || blocking) return
				try {
					window.sessionStorage.setItem(storageKey, '1')
				} catch {
					// Storage can be blocked; the dialog just comes back next load.
				}
				setPostponed(true)
			}}
			disablePointerDismissal={blocking}
		>
			<DialogContent
				className="sm:max-w-lg"
				showCloseButton={!blocking}
				data-testid="agreement-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Our agreements have changed</Trans>
					</DialogTitle>
					<DialogDescription>
						{blocking ? (
							<Trans>
								Please read and accept the updated agreements to keep using your
								dashboard.
							</Trans>
						) : (
							<Trans>
								Please read and accept the updated agreements. You can do it
								later, but some changes become required soon.
							</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				<ul className="space-y-3">
					{pending.map((agreement) => {
						const title = agreementText(agreement.title, i18n.locale)
						const summary = agreementText(agreement.summary, i18n.locale)
						const requiredBy = agreement.requiredBy
							? new Date(agreement.requiredBy).toLocaleDateString(i18n.locale)
							: null
						return (
							<li
								key={`${agreement.key}:${agreement.version}`}
								className="border-border rounded-lg border p-3"
							>
								<p className="text-sm font-medium">
									{title || agreement.key}{' '}
									<span className="text-muted-foreground font-normal">
										<VersionLabel version={agreement.version} />
									</span>
								</p>
								{summary ? (
									<p className="text-muted-foreground mt-1 text-sm">
										{summary}
									</p>
								) : null}
								{requiredBy ? (
									<p className="text-muted-foreground mt-1 text-xs">
										{agreement.overdue ? (
											<Trans>Required since {requiredBy}</Trans>
										) : (
											<Trans>Required by {requiredBy}</Trans>
										)}
									</p>
								) : null}
								<a
									className="text-primary mt-2 inline-block text-sm underline"
									href={agreementHref(agreement.url)}
									target="_blank"
									rel="noreferrer"
								>
									<Trans>Read the full text</Trans>
								</a>
							</li>
						)
					})}
				</ul>
				{!canAccept ? (
					<p role="note" className="text-muted-foreground text-xs">
						<Trans>
							A support session cannot accept on your behalf. The owner of the
							restaurant has to accept these.
						</Trans>
					</p>
				) : null}
				{error ? (
					<p role="alert" className="text-destructive text-xs">
						{error === 'superseded'
							? _(msg`A newer version was just published. Reload to read it.`)
							: _(msg`We could not record your acceptance. Try again.`)}
					</p>
				) : null}
				<DialogFooter>
					{!blocking ? (
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								try {
									window.sessionStorage.setItem(storageKey, '1')
								} catch {
									// ignore
								}
								setPostponed(true)
							}}
						>
							<Trans>Remind me later</Trans>
						</Button>
					) : null}
					<Button
						type="button"
						disabled={busy || !canAccept}
						onClick={() => {
							void fetcher.submit(
								{
									intent: 'accept-agreements',
									items: JSON.stringify(
										pending.map(({ key, version }) => ({ key, version })),
									),
								},
								{ method: 'POST', action: `/${orgSlug}/settings/legal` },
							)
						}}
					>
						{busy ? <Spinner /> : null}
						<Trans>I agree</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
