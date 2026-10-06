import { Trans } from '@lingui/macro'
import { CHAT_RETENTION_DAY_OPTIONS } from '@repo/common/chat'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { StatusButton } from '@repo/ui/status-button'
import {
	Form,
	Link,
	useActionData,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { action, loader } from './chat-retention.server.ts'

export { action, loader }

export default function ChatRetentionPage() {
	const { organization, retentionDays } = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const navigation = useNavigation()
	const pending = navigation.state !== 'idle'
	const organizationName = organization.name

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
					<Trans>Message retention</Trans>
				</h1>
				<p className="text-muted-foreground text-sm">
					<Trans>Manage team chat retention for {organizationName}.</Trans>
				</p>
			</header>
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Retention policy</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							This policy applies to all channels, direct messages, and group
							chats in this organization. Only platform admins can change it.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Form method="POST" className="space-y-4">
						<input type="hidden" name="intent" value="retention" />
						<div className="max-w-xs space-y-2">
							<Label htmlFor="chat-retention-days">
								<Trans>Retention period</Trans>
							</Label>
							<Select
								key={retentionDays ?? 'forever'}
								name="days"
								defaultValue={
									retentionDays === null ? 'forever' : String(retentionDays)
								}
								disabled={pending}
								items={{
									forever: <Trans>Keep forever</Trans>,
									...Object.fromEntries(
										CHAT_RETENTION_DAY_OPTIONS.map((days) => [
											String(days),
											<Trans key={days}>{days} days</Trans>,
										]),
									),
								}}
							>
								<SelectTrigger
									id="chat-retention-days"
									aria-describedby="chat-retention-warning"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="forever">
										<Trans>Keep forever</Trans>
									</SelectItem>
									{CHAT_RETENTION_DAY_OPTIONS.map((days) => (
										<SelectItem key={days} value={String(days)}>
											<Trans>{days} days</Trans>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<p
							id="chat-retention-warning"
							className="text-muted-foreground text-sm"
						>
							<Trans>
								Shorter retention periods permanently remove older messages on
								the next daily cleanup. Deleted messages cannot be recovered.
							</Trans>
						</p>
						{actionData?.error ? (
							<p role="alert" className="text-destructive text-sm">
								<Trans>Choose a valid retention period.</Trans>
							</p>
						) : null}
						<StatusButton
							type="submit"
							status={pending ? 'pending' : 'idle'}
							disabled={pending}
						>
							<Trans>Save retention</Trans>
						</StatusButton>
					</Form>
				</CardContent>
			</Card>
		</div>
	)
}
