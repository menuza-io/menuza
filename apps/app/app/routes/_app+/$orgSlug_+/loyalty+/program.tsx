import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { isImpersonating } from '@repo/auth'
import {
	and,
	asc,
	db,
	eq,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import {
	LOYALTY_PERMISSIONS,
	type LoyaltyOperatorProgram,
	type LoyaltyProgramConfig,
} from '@repo/loyalty'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ProgramForm } from '#app/components/loyalty/program-form.tsx'
import { useLoyaltyClient } from '#app/hooks/use-loyalty-client.ts'
import { requireLoyaltyAccess } from '#app/utils/loyalty/access.server.ts'
import { loadLoyaltyCatalog } from '#app/utils/loyalty/catalog.server.ts'
import {
	afterFailedLoyaltySubmit,
	loyaltyKeyForSubmit,
	newLoyaltySubmitKey,
	type LoyaltySubmitKeyRef,
} from '#app/utils/loyalty/loyalty-client.ts'
import { loyaltyErrorMessage } from '#app/utils/loyalty/loyalty-errors.ts'
import {
	LOYALTY_PROGRAM_STATUS_LABELS,
	loyaltyEnumLabel,
} from '#app/utils/loyalty/loyalty-labels.ts'
import { formatLoyaltyInstant } from '#app/utils/loyalty/loyalty-view.ts'
import { LOYALTY_SECTION_REQUIREMENTS } from '#app/utils/loyalty/sections.ts'
import { type Route } from './+types/program.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireLoyaltyAccess(request, params.orgSlug, {
		anyOf: LOYALTY_SECTION_REQUIREMENTS.program.anyOf,
	})
	const impersonated = await isImpersonating(request)
	const [[organization], [location], catalog] = await Promise.all([
		db
			.select({ timeZone: Organization.staffingTimeZone })
			.from(Organization)
			.where(eq(Organization.id, access.organizationId))
			.limit(1),
		db
			.select({ timeZone: OrganizationLocation.timezone })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, access.organizationId),
					eq(OrganizationLocation.isActive, true),
				),
			)
			.orderBy(asc(OrganizationLocation.createdAt))
			.limit(1),
		loadLoyaltyCatalog(access.organizationId),
	])
	return {
		orgSlug: access.orgSlug,
		catalog,
		canManage:
			!impersonated &&
			access.grants.includes(LOYALTY_PERMISSIONS.UPDATE_LOYALTY_PROGRAM),
		defaultTimeZone:
			location?.timeZone ?? organization?.timeZone ?? 'America/New_York',
	}
}

export default function LoyaltyProgramRoute() {
	const { i18n } = useLingui()
	const tx = useCallback((d: MessageDescriptor) => i18n._(d), [i18n])
	const { canManage, catalog, defaultTimeZone } = useLoaderData<typeof loader>()
	const client = useLoyaltyClient()

	const [program, setProgram] = useState<LoyaltyOperatorProgram | null>(null)
	const [loading, setLoading] = useState(true)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [formError, setFormError] = useState<string | null>(null)
	const [stale, setStale] = useState(false)
	const [saving, setSaving] = useState(false)
	const [statusBusy, setStatusBusy] = useState(false)
	const [savedBanner, setSavedBanner] = useState(false)
	// A status change replaces the saved program and remounts the form, which
	// would drop typed edits, so the status buttons wait until the form is clean.
	const [formDirty, setFormDirty] = useState(false)
	const submitKeyRef = useRef<LoyaltySubmitKeyRef | null>(null)
	if (!submitKeyRef.current) {
		submitKeyRef.current = { current: newLoyaltySubmitKey('program') }
	}
	const statusKeyRef = useRef<LoyaltySubmitKeyRef | null>(null)
	if (!statusKeyRef.current) {
		statusKeyRef.current = { current: newLoyaltySubmitKey('status') }
	}

	const load = useCallback(async () => {
		setLoading(true)
		setLoadError(null)
		setStale(false)
		try {
			setProgram(await client.getProgram())
		} catch (err) {
			setLoadError(
				loyaltyErrorMessage(err, tx, msg`The program could not be loaded.`),
			)
		} finally {
			setLoading(false)
		}
	}, [client, tx])

	useEffect(() => {
		void load()
	}, [load])

	const handleSubmitError = useCallback(
		(err: unknown, fallback: MessageDescriptor) => {
			const code =
				err instanceof Error && 'code' in err
					? (err as { code?: string | null }).code
					: null
			if (code === 'stale_version') {
				setStale(true)
				setFormError(
					tx(
						msg`Someone else saved changes first. Reload to see the latest version, then try again.`,
					),
				)
			} else {
				setFormError(loyaltyErrorMessage(err, tx, fallback))
			}
		},
		[tx],
	)

	const saveConfig = useCallback(
		async (config: LoyaltyProgramConfig, expectedVersion: number | null) => {
			const keyRef = submitKeyRef.current!
			setSaving(true)
			setFormError(null)
			setSavedBanner(false)
			try {
				const saved = await client.saveProgram(
					{ expectedVersion, config },
					loyaltyKeyForSubmit(keyRef, 'program', { expectedVersion, config }),
				)
				setProgram(saved)
				setSavedBanner(true)
				keyRef.current = newLoyaltySubmitKey('program')
			} catch (err) {
				afterFailedLoyaltySubmit(keyRef, 'program', err)
				handleSubmitError(err, msg`The program could not be saved.`)
			} finally {
				setSaving(false)
			}
		},
		[client, handleSubmitError],
	)

	const changeStatus = useCallback(
		async (status: 'active' | 'paused') => {
			const keyRef = statusKeyRef.current!
			if (!program) return
			setStatusBusy(true)
			setFormError(null)
			setSavedBanner(false)
			const body = { expectedVersion: program.version, status }
			try {
				const saved = await client.setProgramStatus(
					body,
					loyaltyKeyForSubmit(keyRef, 'status', body),
				)
				setProgram(saved)
				keyRef.current = newLoyaltySubmitKey('status')
			} catch (err) {
				afterFailedLoyaltySubmit(keyRef, 'status', err)
				handleSubmitError(err, msg`The program status could not be changed.`)
			} finally {
				setStatusBusy(false)
			}
		},
		[client, program, handleSubmitError],
	)

	if (loading) {
		return (
			<div
				role="status"
				className="flex flex-col gap-4"
				data-testid="loyalty-program-loading"
			>
				<span className="sr-only">
					<Trans>Loading the program…</Trans>
				</span>
				<Skeleton className="h-10 w-64" />
				<Skeleton className="h-96 w-full" />
			</div>
		)
	}

	if (loadError) {
		return (
			<Alert variant="destructive" data-testid="loyalty-program-load-error">
				<Icon name="alert-triangle" />
				<AlertDescription>
					<div className="flex flex-wrap items-center gap-3">
						{loadError}
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => void load()}
						>
							<Trans>Try again</Trans>
						</Button>
					</div>
				</AlertDescription>
			</Alert>
		)
	}

	const programVersion = program?.version ?? 0
	const effectiveOn = program
		? (formatLoyaltyInstant(
				program.current.effectiveAt,
				i18n.locale,
				program.current.config.timeZone,
			) ?? '')
		: ''

	return (
		<div className="flex flex-col gap-4" data-testid="loyalty-program-page">
			{program ? (
				<Card data-testid="loyalty-program-status-card">
					<CardHeader className="pb-2">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div className="flex min-w-0 flex-col gap-1">
								<CardTitle className="flex items-center gap-2 text-base">
									<Trans>Status</Trans>
									<Badge
										variant={
											program.status === 'active'
												? 'success'
												: program.status === 'paused'
													? 'warning'
													: 'secondary'
										}
										data-testid="loyalty-program-status-badge"
									>
										{loyaltyEnumLabel(
											tx,
											LOYALTY_PROGRAM_STATUS_LABELS,
											program.status,
										)}
									</Badge>
								</CardTitle>
								<CardDescription>
									{program.status === 'active' ? (
										<Trans>
											Customers are earning and redeeming. Version{' '}
											<bdi dir="ltr" className="tabular-nums">
												v{programVersion}
											</bdi>
											, effective {effectiveOn}.
										</Trans>
									) : program.status === 'paused' ? (
										<Trans>
											Earning and redemption are paused. Balances are kept.
										</Trans>
									) : (
										<Trans>
											A draft is invisible to customers until you activate it.
										</Trans>
									)}
								</CardDescription>
							</div>
							{canManage ? (
								<div className="flex shrink-0 flex-col items-end gap-1">
									<div className="flex items-center gap-2">
										{program.status !== 'active' ? (
											<Button
												type="button"
												size="sm"
												disabled={statusBusy || formDirty}
												onClick={() => void changeStatus('active')}
												data-testid="loyalty-program-activate"
											>
												<Icon name="check" className="size-4" />
												{program.status === 'paused' ? (
													<Trans>Resume program</Trans>
												) : (
													<Trans>Activate program</Trans>
												)}
											</Button>
										) : null}
										{program.status === 'active' ? (
											<Button
												type="button"
												size="sm"
												variant="outline"
												disabled={statusBusy || formDirty}
												onClick={() => void changeStatus('paused')}
												data-testid="loyalty-program-pause"
											>
												<Trans>Pause program</Trans>
											</Button>
										) : null}
									</div>
									{formDirty ? (
										<p
											className="text-muted-foreground text-xs"
											data-testid="loyalty-program-status-hint"
										>
											<Trans>Save your edits before changing the status.</Trans>
										</p>
									) : null}
								</div>
							) : null}
						</div>
					</CardHeader>
				</Card>
			) : null}

			{formError ? (
				<Alert variant="destructive" data-testid="loyalty-program-error">
					<Icon name="alert-triangle" />
					<AlertDescription>
						<div className="flex flex-wrap items-center gap-3">
							{formError}
							{stale ? (
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => void load()}
								>
									<Trans>Reload</Trans>
								</Button>
							) : null}
						</div>
					</AlertDescription>
				</Alert>
			) : null}
			{savedBanner ? (
				<Alert data-testid="loyalty-program-saved">
					<Icon name="check" />
					<AlertDescription>
						<Trans>Program saved.</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{!canManage ? (
				<Alert data-testid="loyalty-program-readonly">
					<Icon name="lock" />
					<AlertDescription>
						<Trans>
							You can view the program but not change it. Ask an administrator
							for edit access.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			<ProgramForm
				key={program ? `v${program.version}` : 'new'}
				program={program}
				catalog={catalog}
				defaultTimeZone={defaultTimeZone}
				canManage={canManage}
				saving={saving}
				onSave={saveConfig}
				onDirtyChange={setFormDirty}
			/>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
