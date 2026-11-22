import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { MAX_SMS_GRANT } from '@repo/common/marketing-allowance'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { StatusButton } from '@repo/ui/status-button'
import {
	Form,
	Link,
	useActionData,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { action, loader } from './text-sends.server.ts'

export { action, loader }

export default function TextSendsPage() {
	const { organization, allowance } = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const navigation = useNavigation()
	const pending = navigation.state !== 'idle'
	const { i18n } = useLingui()
	const name = organization.name
	const resets = new Intl.DateTimeFormat(i18n.locale, {
		dateStyle: 'long',
		timeZone: 'UTC',
	}).format(new Date(allowance.resetsAt))
	return (
		<div className="space-y-6">
			<Button
				variant="outline"
				size="sm"
				role="link"
				render={
					<Link to={`/organizations/${organization.id}`}>
						<Trans>Back to organization</Trans>
					</Link>
				}
			/>
			<header className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">
					<Trans>Text sends</Trans>
				</h1>
				<p className="text-muted-foreground text-sm">
					<Trans>
						Marketing text sends for {name} this month. Order and booking texts
						never count.
					</Trans>
				</p>
			</header>
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>This month</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>The allowance comes back on {resets}.</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<dl className="grid max-w-md grid-cols-2 gap-2 text-sm">
						<dt className="text-muted-foreground">
							<Trans>Plan</Trans>
						</dt>
						<dd data-testid="admin-plan">{organization.planName ?? '-'}</dd>
						<dt className="text-muted-foreground">
							<Trans>Allowed (with extras)</Trans>
						</dt>
						<dd data-testid="admin-limit">{allowance.limit}</dd>
						<dt className="text-muted-foreground">
							<Trans>Extra sends granted</Trans>
						</dt>
						<dd data-testid="admin-extra">{allowance.extra}</dd>
						<dt className="text-muted-foreground">
							<Trans>Used</Trans>
						</dt>
						<dd data-testid="admin-used">{allowance.used}</dd>
						<dt className="text-muted-foreground">
							<Trans>Left</Trans>
						</dt>
						<dd data-testid="admin-remaining">{allowance.remaining}</dd>
					</dl>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Grant extra sends</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Extra sends are added to this month only. Each grant is recorded
							in the audit log.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Form method="POST" className="space-y-4">
						<input type="hidden" name="intent" value="grant" />
						<div className="max-w-xs space-y-2">
							<Label htmlFor="extra-sends">
								<Trans>Extra sends</Trans>
							</Label>
							<Input
								id="extra-sends"
								name="extra"
								type="number"
								min={1}
								max={MAX_SMS_GRANT}
								defaultValue={1}
								required
							/>
						</div>
						{actionData?.error ? (
							<p role="alert" className="text-destructive text-sm">
								{actionData.error}
							</p>
						) : null}
						<StatusButton
							type="submit"
							status={pending ? 'pending' : 'idle'}
							disabled={pending}
						>
							<Trans>Grant</Trans>
						</StatusButton>
					</Form>
				</CardContent>
			</Card>
		</div>
	)
}
