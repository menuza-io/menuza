/**
 * Settings, Legal (#194): the Menuza agreements this restaurant accepted, with
 * the version, who accepted and when, and any it still has to accept. Owners
 * accept here or in the dialog; nobody else can, and a support session never
 * accepts for the owner. Reading needs `read:settings:any`.
 */
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { PageHeader } from '@repo/ui/page-header'
import { Spinner } from '@repo/ui/spinner'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useEffect } from 'react'
import {
	type ActionFunctionArgs,
	data,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
	useNavigate,
} from 'react-router'
import { z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	agreementHref,
	agreementText,
	VersionLabel,
} from '#app/components/legal/agreement-dialog.tsx'
import {
	acceptAgreements,
	agreementPromptFor,
	listAcceptances,
	requireModuleAgreement,
} from '#app/utils/legal/agreements.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_SETTINGS_ANY,
	)
	const [acceptances, prompt] = await Promise.all([
		listAcceptances(organization.id),
		agreementPromptFor({ request, userId, organizationId: organization.id! }),
	])
	// A module with its own terms (payments, text marketing) sends the owner
	// here with `?agreement=<key>&next=<page>` before it is turned on.
	const url = new URL(request.url)
	const wanted = url.searchParams.get('agreement')
	const moduleAgreement =
		wanted === 'payments' || wanted === 'text_marketing'
			? await requireModuleAgreement(organization.id!, wanted)
			: null
	const next = url.searchParams.get('next')
	return {
		acceptances,
		pending: [
			...prompt.pending,
			...(moduleAgreement &&
			!prompt.pending.some((agreement) => agreement.key === moduleAgreement.key)
				? [moduleAgreement]
				: []),
		],
		canAccept: prompt.canAccept,
		// Only a page of this organization can be returned to.
		next:
			next &&
			next.startsWith(`/${organization.slug}/`) &&
			!next.startsWith('//')
				? next
				: null,
	}
}

const AcceptSchema = z.object({
	intent: z.literal('accept-agreements'),
	items: z
		.string()
		.transform((value, ctx) => {
			try {
				return JSON.parse(value) as unknown
			} catch {
				ctx.addIssue({ code: 'custom', message: 'invalid' })
				return z.NEVER
			}
		})
		.pipe(
			z
				.array(
					z.object({
						key: z.string().min(1).max(40),
						version: z.number().int().positive(),
					}),
				)
				.min(1)
				.max(10),
		),
})

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	const parsed = AcceptSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) {
		return data({ status: 'error', error: 'invalid_request' }, { status: 400 })
	}
	const result = await acceptAgreements({
		request,
		userId,
		organizationId: organization.id!,
		items: parsed.data.items,
		source: parsed.data.items.some(
			(item) => item.key === 'payments' || item.key === 'text_marketing',
		)
			? 'module'
			: 'dialog',
	})
	if (!result.ok) {
		const status =
			result.error === 'impersonating' || result.error === 'not_owner'
				? 403
				: result.error === 'superseded'
					? 409
					: 400
		return data({ status: 'error', error: result.error }, { status })
	}
	return data({ status: 'success' })
}

export default function SettingsLegalRoute() {
	const { acceptances, pending, canAccept, next } =
		useLoaderData<typeof loader>()
	const navigate = useNavigate()
	const { _, i18n } = useLingui()
	const fetcher = useFetcher<{ status?: string; error?: string }>()
	// Back to the page that sent the owner here once the terms are accepted.
	useEffect(() => {
		if (
			fetcher.state === 'idle' &&
			fetcher.data?.status === 'success' &&
			next
		) {
			void navigate(next)
		}
	}, [fetcher.state, fetcher.data, next, navigate])
	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Legal</Trans>}
				description={
					<Trans>
						The Menuza agreements your restaurant accepted, who accepted them
						and when.
					</Trans>
				}
				headingLevel="h2"
				size="section"
			/>
			{pending.length > 0 ? (
				<div
					role="status"
					className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
				>
					<p className="text-sm font-medium">
						<Trans>Waiting for your acceptance</Trans>
					</p>
					<ul className="mt-2 space-y-1 text-sm">
						{pending.map((agreement) => (
							<li key={`${agreement.key}:${agreement.version}`}>
								<a
									className="text-primary underline"
									href={agreementHref(agreement.url)}
									target="_blank"
									rel="noreferrer"
								>
									{agreementText(agreement.title, i18n.locale) || agreement.key}
								</a>{' '}
								<span className="text-muted-foreground">
									<VersionLabel version={agreement.version} />
								</span>
							</li>
						))}
					</ul>
					<Button
						type="button"
						className="mt-3"
						disabled={!canAccept || fetcher.state !== 'idle'}
						onClick={() => {
							void fetcher.submit(
								{
									intent: 'accept-agreements',
									items: JSON.stringify(
										pending.map(({ key, version }) => ({ key, version })),
									),
								},
								{ method: 'POST' },
							)
						}}
					>
						{fetcher.state !== 'idle' ? <Spinner /> : null}
						<Trans>I agree</Trans>
					</Button>
					{!canAccept ? (
						<p className="text-muted-foreground mt-2 text-xs">
							<Trans>
								Only an owner can accept, and not from a support session.
							</Trans>
						</p>
					) : null}
					{fetcher.data?.status === 'error' ? (
						<p role="alert" className="text-destructive mt-2 text-xs">
							{_(msg`We could not record your acceptance.`)}
						</p>
					) : null}
				</div>
			) : null}
			{acceptances.length === 0 ? (
				<EmptyState
					title={_(msg`Nothing accepted yet`)}
					description={_(
						msg`When an owner accepts an agreement, it is listed here with the version and the date.`,
					)}
					icons={['file-text']}
				/>
			) : (
				<Frame className="w-full">
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Agreement</Trans>
								</TableHead>
								<TableHead>
									<Trans>Version</Trans>
								</TableHead>
								<TableHead>
									<Trans>Accepted by</Trans>
								</TableHead>
								<TableHead>
									<Trans>When</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{acceptances.map((row) => (
								<TableRow key={row.id}>
									<TableCell className="font-medium">{row.key}</TableCell>
									<TableCell>{row.version}</TableCell>
									<TableCell>
										{row.acceptedBy ??
											(row.source === 'signup' || row.source === 'backfill'
												? _(msg`At sign-up`)
												: '—')}
									</TableCell>
									<TableCell className="text-muted-foreground">
										{new Date(row.acceptedAt).toLocaleString(i18n.locale)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Frame>
			)}
		</div>
	)
}
