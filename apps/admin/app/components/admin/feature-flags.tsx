import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Card, CardHeader, CardContent, CardTitle } from '@repo/ui/card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@repo/ui/dialog'
import { Frame, FrameHeader, FrameTitle } from '@repo/ui/frame'
import { Input } from '@repo/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import {
	Table,
	TableHeader,
	TableRow,
	TableHead,
	TableBody,
	TableCell,
} from '@repo/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useState, useEffect, useMemo } from 'react'
import { useFetcher, useLoaderData, Form } from 'react-router'
import { type loader } from '#app/routes/_admin+/feature-flags.tsx'

type ConfigFlag = {
	id: string
	key: string
	value: any
	level: 'system' | 'organization' | 'user'
	organizationId?: string | null
	userId?: string | null
	createdAt: Date
	updatedAt: Date
}

function FeatureFlagDialog({
	flag,
	level = 'system',
	organizationId,
	userId,
	children,
}: {
	flag?: ConfigFlag
	level?: 'system' | 'organization' | 'user'
	organizationId?: string
	userId?: string
	children: React.ReactNode
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher()
	const [open, setOpen] = useState(false)
	const [type, setType] = useState(
		typeof flag?.value === 'number'
			? 'number'
			: typeof flag?.value === 'boolean'
				? 'boolean'
				: 'string',
	)

	useEffect(() => {
		if (fetcher.state === 'idle' && fetcher.data?.ok) {
			setOpen(false)
		}
	}, [fetcher.state, fetcher.data])

	useEffect(() => {
		if (!open) {
			setType(
				typeof flag?.value === 'number'
					? 'number'
					: typeof flag?.value === 'boolean'
						? 'boolean'
						: 'string',
			)
		}
	}, [open, flag])

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger>{children}</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{flag ? <Trans>Edit Flag</Trans> : <Trans>Add Flag</Trans>}
					</DialogTitle>
					<DialogDescription>
						{flag ? (
							<Trans>Edit the details of the feature flag.</Trans>
						) : (
							<Trans>Create a new feature flag at system level.</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				{fetcher.data?.error && (
					<p className="text-destructive text-sm">{fetcher.data.error}</p>
				)}
				<fetcher.Form method="post" action="/feature-flags">
					<input
						type="hidden"
						name="_action"
						value={flag ? 'update' : 'create'}
					/>
					{flag && <input type="hidden" name="id" value={flag.id} />}
					<input type="hidden" name="level" value={level} />
					{organizationId && (
						<input type="hidden" name="organizationId" value={organizationId} />
					)}
					{userId && <input type="hidden" name="userId" value={userId} />}
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
						<Input
							name="key"
							placeholder={_(msg`Flag Key`)}
							required
							defaultValue={flag?.key}
							disabled={!!flag}
						/>
						<Select
							name="type"
							defaultValue={type}
							onValueChange={(value) => setType(value as string)}
							aria-label={_(msg`Select flag type`)}
						>
							<SelectTrigger>
								<Trans>Type</Trans>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="string">
									<Trans>String</Trans>
								</SelectItem>
								<SelectItem value="number">
									<Trans>Number</Trans>
								</SelectItem>
								<SelectItem value="boolean">
									<Trans>Boolean</Trans>
								</SelectItem>
								<SelectItem value="date">
									<Trans>Date</Trans>
								</SelectItem>
							</SelectContent>
						</Select>
						{type === 'string' && (
							<Input
								name="value"
								placeholder={_(msg`Flag Value`)}
								required
								defaultValue={(flag?.value as string) ?? ''}
							/>
						)}
						{type === 'number' && (
							<Input
								name="value"
								type="number"
								placeholder={_(msg`Flag Value`)}
								required
								defaultValue={(flag?.value as number) ?? 0}
							/>
						)}
						{type === 'boolean' && (
							<Switch
								name="value"
								defaultChecked={(flag?.value as boolean) ?? false}
							/>
						)}
						{type === 'date' && (
							<input
								type="date"
								name="value"
								defaultValue={
									flag?.value
										? new Date(flag.value as string).toISOString().slice(0, 10)
										: new Date().toISOString().slice(0, 10)
								}
							/>
						)}
					</div>
					<div className="mt-4 flex justify-end">
						<Button type="submit">
							{flag ? <Trans>Update Flag</Trans> : <Trans>Create Flag</Trans>}
						</Button>
					</div>
				</fetcher.Form>
			</DialogContent>
		</Dialog>
	)
}

function OverrideDialog({
	systemFlag,
	existingOverride,
	level,
	organizationId,
	userId,
	children,
}: {
	systemFlag: ConfigFlag
	existingOverride?: ConfigFlag
	level: 'organization' | 'user'
	organizationId?: string
	userId?: string
	children: React.ReactNode
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher()
	const [open, setOpen] = useState(false)
	const [type, ignoredSetType] = useState(
		typeof systemFlag.value === 'number'
			? 'number'
			: typeof systemFlag.value === 'boolean'
				? 'boolean'
				: 'string',
	)
	void ignoredSetType

	useEffect(() => {
		if (fetcher.state === 'idle' && fetcher.data?.ok) {
			setOpen(false)
		}
	}, [fetcher.state, fetcher.data])

	const currentValue = existingOverride?.value ?? systemFlag.value
	const flagKey = systemFlag.key

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger>{children}</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{existingOverride ? (
							<Trans>Edit Override for "{flagKey}"</Trans>
						) : (
							<Trans>Create Override for "{flagKey}"</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						{existingOverride ? (
							<Trans>Modify the override value.</Trans>
						) : level === 'organization' ? (
							<Trans>Create an override at organization level.</Trans>
						) : (
							<Trans>Create an override at user level.</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				{fetcher.data?.error && (
					<p className="text-destructive text-sm">{fetcher.data.error}</p>
				)}
				<fetcher.Form method="post" action="/feature-flags">
					<input
						type="hidden"
						name="_action"
						value={existingOverride ? 'update' : 'create'}
					/>
					{existingOverride && (
						<input type="hidden" name="id" value={existingOverride.id} />
					)}
					<input type="hidden" name="key" value={systemFlag.key} />
					<input type="hidden" name="level" value={level} />
					{organizationId && (
						<input type="hidden" name="organizationId" value={organizationId} />
					)}
					{userId && <input type="hidden" name="userId" value={userId} />}
					<input type="hidden" name="type" value={type} />
					<div className="space-y-4">
						<div className="text-muted-foreground text-sm">
							<Trans>System value:</Trans>{' '}
							<span className="font-mono">
								{JSON.stringify(systemFlag.value)}
							</span>
						</div>
						{type === 'string' && (
							<Input
								name="value"
								placeholder={_(msg`Override Value`)}
								required
								defaultValue={(currentValue as string) ?? ''}
							/>
						)}
						{type === 'number' && (
							<Input
								name="value"
								type="number"
								placeholder={_(msg`Override Value`)}
								required
								defaultValue={(currentValue as number) ?? 0}
							/>
						)}
						{type === 'boolean' && (
							<div className="flex items-center gap-2">
								<Switch
									name="value"
									defaultChecked={(currentValue as boolean) ?? false}
								/>
								<span className="text-sm">
									<Trans>Enabled</Trans>
								</span>
							</div>
						)}
						{type === 'date' && (
							<input
								type="date"
								name="value"
								className="rounded border px-3 py-2"
								defaultValue={
									currentValue
										? new Date(currentValue as string)
												.toISOString()
												.slice(0, 10)
										: new Date().toISOString().slice(0, 10)
								}
							/>
						)}
					</div>
					<div className="mt-4 flex justify-end gap-2">
						{existingOverride && (
							<Button
								type="button"
								variant="outline"
								onClick={() => {
									const formData = new FormData()
									formData.append('_action', 'delete')
									formData.append('id', existingOverride.id)
									void fetcher.submit(formData, {
										method: 'post',
										action: '/feature-flags',
									})
								}}
							>
								<Trans>Remove Override</Trans>
							</Button>
						)}
						<Button type="submit">
							{existingOverride ? (
								<Trans>Update Override</Trans>
							) : (
								<Trans>Create Override</Trans>
							)}
						</Button>
					</div>
				</fetcher.Form>
			</DialogContent>
		</Dialog>
	)
}

function SystemTab({ flags }: { flags: ConfigFlag[] }) {
	const systemFlags = flags.filter((f) => f.level === 'system')

	return (
		<div className="space-y-4">
			<Frame className="w-full">
				<FrameHeader>
					<FrameTitle className="font-medium">
						<Trans>System Flags</Trans>
					</FrameTitle>
				</FrameHeader>
				<Table variant="card">
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>Key</Trans>
							</TableHead>
							<TableHead>
								<Trans>Value</Trans>
							</TableHead>
							<TableHead>
								<Trans>Actions</Trans>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{systemFlags.length === 0 ? (
							<TableRow>
								<TableCell
									colSpan={3}
									className="text-muted-foreground text-center"
								>
									<Trans>No system flags configured</Trans>
								</TableCell>
							</TableRow>
						) : (
							systemFlags.map((flag) => (
								<TableRow key={flag.id}>
									<TableCell className="font-mono">{flag.key}</TableCell>
									<TableCell className="font-mono">
										{JSON.stringify(flag.value)}
									</TableCell>
									<TableCell>
										<FeatureFlagDialog flag={flag}>
											<Button variant="outline" size="sm" className="mr-2">
												<Trans>Edit</Trans>
											</Button>
										</FeatureFlagDialog>
										<Form method="post" className="inline-block">
											<input type="hidden" name="_action" value="delete" />
											<input type="hidden" name="id" value={flag.id} />
											<Button type="submit" variant="destructive" size="sm">
												<Trans>Delete</Trans>
											</Button>
										</Form>
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</Frame>
		</div>
	)
}

function OrganizationTab({ flags }: { flags: ConfigFlag[] }) {
	const { _ } = useLingui()
	const [orgId, setOrgId] = useState('')
	const [searchedOrgId, setSearchedOrgId] = useState<string | null>(null)

	const systemFlags = flags.filter((f) => f.level === 'system')
	const orgOverrides = searchedOrgId
		? flags.filter(
				(f) => f.level === 'organization' && f.organizationId === searchedOrgId,
			)
		: []

	const handleSearch = () => {
		if (orgId.trim()) {
			setSearchedOrgId(orgId.trim())
		}
	}

	return (
		<div className="space-y-4">
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Search Organization</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="flex gap-2">
						<Input
							placeholder={_(msg`Enter Organization ID`)}
							value={orgId}
							onChange={(e) => setOrgId(e.target.value)}
							onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
						/>
						<Button onClick={handleSearch}>
							<Trans>Search</Trans>
						</Button>
					</div>
				</CardContent>
			</Card>

			{searchedOrgId && (
				<Frame className="w-full">
					<FrameHeader>
						<FrameTitle className="font-medium">
							<Trans>Flags for Organization: {searchedOrgId}</Trans>
						</FrameTitle>
					</FrameHeader>
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Key</Trans>
								</TableHead>
								<TableHead>
									<Trans>Effective Value</Trans>
								</TableHead>
								<TableHead>
									<Trans>Source</Trans>
								</TableHead>
								<TableHead>
									<Trans>Actions</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{systemFlags.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={4}
										className="text-muted-foreground text-center"
									>
										<Trans>No flags configured</Trans>
									</TableCell>
								</TableRow>
							) : (
								systemFlags.map((systemFlag) => {
									const override = orgOverrides.find(
										(o) => o.key === systemFlag.key,
									)
									const effectiveValue = override?.value ?? systemFlag.value

									return (
										<TableRow key={systemFlag.id}>
											<TableCell className="font-mono">
												{systemFlag.key}
											</TableCell>
											<TableCell className="font-mono">
												{JSON.stringify(effectiveValue)}
											</TableCell>
											<TableCell>
												<span
													className={
														override ? 'text-blue-500' : 'text-muted-foreground'
													}
												>
													{override ? (
														<Trans>Organization Override</Trans>
													) : (
														<Trans>System Default</Trans>
													)}
												</span>
											</TableCell>
											<TableCell>
												<OverrideDialog
													systemFlag={systemFlag}
													existingOverride={override}
													level="organization"
													organizationId={searchedOrgId}
												>
													<Button variant="outline" size="sm">
														{override ? (
															<Trans>Edit Override</Trans>
														) : (
															<Trans>Add Override</Trans>
														)}
													</Button>
												</OverrideDialog>
											</TableCell>
										</TableRow>
									)
								})
							)}
						</TableBody>
					</Table>
				</Frame>
			)}
		</div>
	)
}

function UserTab({ flags }: { flags: ConfigFlag[] }) {
	const { _ } = useLingui()
	const [userId, setUserId] = useState('')
	const [searchedUserId, setSearchedUserId] = useState<string | null>(null)
	const [orgId, setOrgId] = useState('')
	const [searchedOrgId, setSearchedOrgId] = useState<string | null>(null)

	const systemFlags = useMemo(
		() => flags.filter((f) => f.level === 'system'),
		[flags],
	)
	const userOverrides = useMemo(
		() =>
			searchedUserId
				? flags.filter((f) => {
						if (f.level !== 'user' || f.userId !== searchedUserId) return false
						if (searchedOrgId) {
							return f.organizationId === searchedOrgId
						}
						return f.organizationId === null
					})
				: [],
		[flags, searchedUserId, searchedOrgId],
	)

	const handleSearch = () => {
		if (userId.trim()) {
			setSearchedUserId(userId.trim())
			setSearchedOrgId(orgId.trim() || null)
		}
	}

	return (
		<div className="space-y-4">
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Search User</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="flex flex-col gap-4">
						<div className="flex gap-2">
							<Input
								placeholder={_(msg`Enter User ID (required)`)}
								value={userId}
								onChange={(e) => setUserId(e.target.value)}
								onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
							/>
						</div>
						<div className="flex gap-2">
							<Input
								placeholder={_(
									msg`Enter Organization ID (optional - for per-org overrides)`,
								)}
								value={orgId}
								onChange={(e) => setOrgId(e.target.value)}
								onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
							/>
						</div>
						<Button onClick={handleSearch} className="w-fit">
							<Trans>Search</Trans>
						</Button>
					</div>
					<p className="text-muted-foreground mt-2 text-xs">
						<Trans>
							Leave Organization ID empty to view/set global user overrides.
							Enter an Organization ID to view/set overrides for that specific
							organization.
						</Trans>
					</p>
				</CardContent>
			</Card>

			{searchedUserId && (
				<Card>
					<CardHeader>
						<CardTitle>
							{searchedOrgId ? (
								<Trans>
									Flags for User: {searchedUserId} (Org: {searchedOrgId})
								</Trans>
							) : (
								<Trans>Flags for User: {searchedUserId} (Global)</Trans>
							)}
						</CardTitle>
					</CardHeader>
					<CardContent>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Key</Trans>
									</TableHead>
									<TableHead>
										<Trans>Effective Value</Trans>
									</TableHead>
									<TableHead>
										<Trans>Source</Trans>
									</TableHead>
									<TableHead>
										<Trans>Actions</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{systemFlags.length === 0 ? (
									<TableRow>
										<TableCell
											colSpan={4}
											className="text-muted-foreground text-center"
										>
											<Trans>No flags configured</Trans>
										</TableCell>
									</TableRow>
								) : (
									systemFlags.map((systemFlag) => {
										const override = userOverrides.find(
											(o) => o.key === systemFlag.key,
										)
										const effectiveValue = override?.value ?? systemFlag.value

										return (
											<TableRow key={systemFlag.id}>
												<TableCell className="font-mono">
													{systemFlag.key}
												</TableCell>
												<TableCell className="font-mono">
													{JSON.stringify(effectiveValue)}
												</TableCell>
												<TableCell>
													<span
														className={
															override
																? 'text-green-500'
																: 'text-muted-foreground'
														}
													>
														{override ? (
															searchedOrgId ? (
																<Trans>User+Org Override</Trans>
															) : (
																<Trans>User Override</Trans>
															)
														) : (
															<Trans>System Default</Trans>
														)}
													</span>
												</TableCell>
												<TableCell>
													<OverrideDialog
														systemFlag={systemFlag}
														existingOverride={override}
														level="user"
														userId={searchedUserId}
														organizationId={searchedOrgId ?? undefined}
													>
														<Button variant="outline" size="sm">
															{override ? (
																<Trans>Edit Override</Trans>
															) : (
																<Trans>Add Override</Trans>
															)}
														</Button>
													</OverrideDialog>
												</TableCell>
											</TableRow>
										)
									})
								)}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}
		</div>
	)
}

export function FeatureFlags() {
	const { flags } = useLoaderData<typeof loader>()

	return (
		<div className="space-y-6">
			<Tabs defaultValue="system" className="w-full">
				<div className="flex gap-3">
					<TabsList>
						<TabsTrigger value="system">
							<Trans>System</Trans>
						</TabsTrigger>
						<TabsTrigger value="organization">
							<Trans>Organization</Trans>
						</TabsTrigger>
						<TabsTrigger value="user">
							<Trans>User</Trans>
						</TabsTrigger>
					</TabsList>
					<FeatureFlagDialog>
						<Button>
							<Trans>Add Flag</Trans>
						</Button>
					</FeatureFlagDialog>
				</div>

				<TabsContent value="system" className="mt-6">
					<SystemTab flags={flags} />
				</TabsContent>

				<TabsContent value="organization" className="mt-6">
					<OrganizationTab flags={flags} />
				</TabsContent>

				<TabsContent value="user" className="mt-6">
					<UserTab flags={flags} />
				</TabsContent>
			</Tabs>
		</div>
	)
}
