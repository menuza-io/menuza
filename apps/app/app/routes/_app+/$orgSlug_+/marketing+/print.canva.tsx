import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { printCatalog } from '@repo/common/print-shop-catalog'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Field, FieldLabel, FieldLegend, FieldSet } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { useState } from 'react'
import {
	Form,
	Link,
	redirect,
	useActionData,
	useLoaderData,
	useNavigation,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import {
	PRINT_ARTWORK_ERROR_FALLBACK,
	PRINT_ARTWORK_ERROR_LABELS,
} from '#app/components/print/artwork-labels.ts'
import { printProductLabel } from '#app/components/print/print-labels.ts'
import { requirePrintShopAccess } from '#app/utils/print/access.server.ts'
import {
	importCanvaArtwork,
	PrintArtworkError,
} from '#app/utils/print/artwork.server.ts'
import {
	CanvaError,
	downloadCanvaFile,
	type CanvaDesign,
} from '#app/utils/print/canva/client.server.ts'
import {
	deleteCanvaConnection,
	getCanvaConnection,
	withCanva,
} from '#app/utils/print/canva/connection.server.ts'
import { isCanvaConfigured } from '#app/utils/print/canva/env.server.ts'

/**
 * Import from Canva: connect the member's Canva account, pick one of their
 * designs and what it prints as, and it becomes a print (a finished file).
 */

const ImportSchema = z.object({
	intent: z.literal('import'),
	designId: z.string().trim().min(1).max(200),
	product: z.string().refine((key) => printCatalog.acceptsArtwork(key)),
	sizeKey: z.string().trim().min(1).max(20),
	name: z.string().trim().min(1).max(120),
})

/** Canva thumbnails are inlined: the App's CSP loads no third-party images. */
async function thumbnailDataUri(design: CanvaDesign): Promise<string | null> {
	const url = design.thumbnail?.url
	if (!url) return null
	if (url.startsWith('data:image/')) return url
	try {
		const file = await downloadCanvaFile(url, {
			maxBytes: 400 * 1024,
			timeoutMs: 5000,
		})
		if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.contentType)) return null
		return `data:${file.contentType};base64,${Buffer.from(file.bytes).toString('base64')}`
	} catch {
		return null
	}
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug, {
		write: true,
	})
	if (!access.features.canva || !isCanvaConfigured()) {
		throw new Response('Not Found', { status: 404 })
	}
	const url = new URL(request.url)
	const query = (url.searchParams.get('q') ?? '').trim().slice(0, 120)
	const continuation = url.searchParams.get('next') ?? undefined
	const products = printCatalog.productKeys
		.filter((key) => printCatalog.acceptsArtwork(key))
		.map((key) => ({
			key,
			sizes: printCatalog.products[key]!.sizes.map((size) => ({
				key: size.key,
				label: size.label,
			})),
		}))
	const notice = url.searchParams.get('connected')
		? ('connected' as const)
		: url.searchParams.get('canva') === 'denied'
			? ('denied' as const)
			: url.searchParams.get('canva') === 'failed'
				? ('failed' as const)
				: null
	const base = {
		orgSlug: access.organization.slug,
		query,
		products,
		notice,
	}
	const connection = await getCanvaConnection(access)
	if (!connection) return { ...base, connected: false as const }
	try {
		const page = await withCanva(access, (api) =>
			api.listDesigns({ query: query || undefined, continuation }),
		)
		const designs = await Promise.all(
			page.designs.map(async (design) => ({
				id: design.id,
				title: design.title,
				pageCount: design.pageCount,
				thumbnail: await thumbnailDataUri(design),
			})),
		)
		return {
			...base,
			connected: true as const,
			displayName: connection.displayName,
			designs,
			next: page.continuation,
			listError: null,
		}
	} catch (error) {
		if (error instanceof CanvaError && error.code === 'unauthorized') {
			return { ...base, connected: false as const }
		}
		return {
			...base,
			connected: true as const,
			displayName: connection.displayName,
			designs: [],
			next: null,
			listError: 'canva_unavailable',
		}
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug, {
		write: true,
	})
	if (!access.features.canva || !isCanvaConfigured()) {
		throw new Response('Not Found', { status: 404 })
	}
	const formData = await request.formData()
	if (formData.get('intent') === 'disconnect') {
		await deleteCanvaConnection(access)
		return redirect(`/${access.organization.slug}/marketing/print/canva`)
	}
	const input = ImportSchema.safeParse(Object.fromEntries(formData))
	if (!input.success) return { error: 'invalid' }
	try {
		const row = await importCanvaArtwork(access, input.data)
		return redirect(`/${access.organization.slug}/marketing/print/${row.id}`)
	} catch (error) {
		if (error instanceof PrintArtworkError) return { error: error.code }
		throw error
	}
}

export default function CanvaImportRoute() {
	const { _ } = useLingui()
	const data = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const busy = useNavigation().state !== 'idle'
	const [product, setProduct] = useState(data.products[0]?.key ?? '')
	const sizes =
		data.products.find((candidate) => candidate.key === product)?.sizes ?? []
	const [sizeKey, setSizeKey] = useState(sizes[0]?.key ?? '')
	const designs = data.connected ? data.designs : []
	const [designId, setDesignId] = useState('')
	const [name, setName] = useState('')
	const [nameEdited, setNameEdited] = useState(false)
	const chooseDesign = (id: string) => {
		setDesignId(id)
		const design = designs.find((candidate) => candidate.id === id)
		if (design && !nameEdited) setName(design.title)
	}
	const chosen = designs.find((design) => design.id === designId)

	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Import from Canva`)}
				description={_(
					msg`Bring in a design you made in Canva. It prints exactly as designed, as a poster, flyer or sign.`,
				)}
				actions={
					<Button
						variant="outline"
						render={<Link to={`/${data.orgSlug}/marketing/print`} />}
					>
						{_(msg`All prints`)}
					</Button>
				}
			/>

			{data.notice === 'connected' ? (
				<Alert role="status">
					<AlertTitle>{_(msg`Canva is connected`)}</AlertTitle>
					<AlertDescription>
						{_(msg`Pick a design below to make it a print.`)}
					</AlertDescription>
				</Alert>
			) : data.notice ? (
				<Alert variant="destructive" role="alert">
					<AlertTitle>{_(msg`Canva was not connected`)}</AlertTitle>
					<AlertDescription>
						{data.notice === 'denied'
							? _(msg`The connection was not allowed in Canva.`)
							: _(msg`Canva did not finish the connection. Try again.`)}
					</AlertDescription>
				</Alert>
			) : null}

			{actionData?.error ? (
				<Alert variant="destructive" role="alert">
					<AlertTitle>{_(msg`The design was not imported`)}</AlertTitle>
					<AlertDescription>
						{actionData.error === 'invalid'
							? _(msg`Choose a design, what it prints as and a name.`)
							: _(
									PRINT_ARTWORK_ERROR_LABELS[actionData.error] ??
										PRINT_ARTWORK_ERROR_FALLBACK,
								)}
					</AlertDescription>
				</Alert>
			) : null}

			{!data.connected ? (
				<Card>
					<CardHeader>
						<CardTitle>{_(msg`Connect your Canva account`)}</CardTitle>
						<CardDescription>
							{_(
								msg`You sign in to Canva and allow access. Only the designs you import are copied here, and you can disconnect at any time.`,
							)}
						</CardDescription>
					</CardHeader>
					<CardContent>
						{/* A full page post: Canva's consent page is another site. */}
						<Form
							method="post"
							action={`/${data.orgSlug}/marketing/print/canva/connect`}
							reloadDocument
						>
							<Button type="submit">{_(msg`Connect Canva`)}</Button>
						</Form>
					</CardContent>
				</Card>
			) : (
				<>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="text-muted-foreground text-sm">
							{data.displayName
								? (() => {
										const who = data.displayName
										return _(msg`Connected to Canva as ${who}.`)
									})()
								: _(msg`Connected to Canva.`)}
						</p>
						<Form method="post">
							<Button
								type="submit"
								name="intent"
								value="disconnect"
								variant="ghost"
								size="sm"
							>
								{_(msg`Disconnect Canva`)}
							</Button>
						</Form>
					</div>

					<Form method="get" className="flex max-w-md gap-2" role="search">
						<Label htmlFor="canva-search" className="sr-only">
							{_(msg`Search your Canva designs`)}
						</Label>
						<Input
							id="canva-search"
							name="q"
							type="search"
							defaultValue={data.query}
							placeholder={_(msg`Search your Canva designs`)}
						/>
						<Button type="submit" variant="outline">
							{_(msg`Search`)}
						</Button>
					</Form>

					{data.listError ? (
						<p role="alert" className="text-destructive text-sm">
							{_(PRINT_ARTWORK_ERROR_LABELS[data.listError]!)}
						</p>
					) : null}

					<Form method="post" className="space-y-8">
						<input type="hidden" name="intent" value="import" />
						<FieldSet>
							<FieldLegend>{_(msg`Design`)}</FieldLegend>
							{designs.length === 0 ? (
								<p className="text-muted-foreground text-sm">
									{data.query
										? _(msg`No Canva designs match that search.`)
										: _(msg`Your Canva account has no designs yet.`)}
								</p>
							) : (
								<RadioGroup
									name="designId"
									value={designId}
									onValueChange={(value) => chooseDesign(String(value))}
									className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
								>
									{designs.map((design) => (
										<Label
											key={design.id}
											className="border-border has-[[data-checked]]:border-primary flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3"
										>
											<RadioGroupItem value={design.id} className="mt-1" />
											<span className="flex min-w-0 flex-col gap-2">
												{design.thumbnail ? (
													<img
														src={design.thumbnail}
														alt=""
														className="bg-muted max-h-40 w-full rounded object-contain"
													/>
												) : null}
												<span className="font-medium wrap-anywhere">
													{design.title}
												</span>
												{design.pageCount && design.pageCount > 1 ? (
													<span className="text-muted-foreground text-xs font-normal">
														{(() => {
															const pages = design.pageCount
															return _(
																msg`${pages} pages: only the first one prints.`,
															)
														})()}
													</span>
												) : null}
											</span>
										</Label>
									))}
								</RadioGroup>
							)}
							{data.next ? (
								<Link
									to={`?${new URLSearchParams({
										...(data.query ? { q: data.query } : {}),
										next: data.next,
									})}`}
									className="text-primary text-sm font-medium underline-offset-4 hover:underline"
								>
									{_(msg`More designs`)}
								</Link>
							) : null}
						</FieldSet>

						<FieldSet>
							<FieldLegend>{_(msg`Print it as`)}</FieldLegend>
							<RadioGroup
								name="product"
								value={product}
								onValueChange={(value) => {
									const next = String(value)
									setProduct(next)
									setSizeKey(
										data.products.find((candidate) => candidate.key === next)
											?.sizes[0]?.key ?? '',
									)
								}}
								className="grid gap-3 sm:grid-cols-3"
							>
								{data.products.map((option) => (
									<Label
										key={option.key}
										className="border-border has-[[data-checked]]:border-primary flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-4"
									>
										<RadioGroupItem value={option.key} />
										{_(printProductLabel(option.key).name)}
									</Label>
								))}
							</RadioGroup>
						</FieldSet>

						<FieldSet>
							<FieldLegend>{_(msg`Size`)}</FieldLegend>
							<RadioGroup
								name="sizeKey"
								value={sizeKey}
								onValueChange={(value) => setSizeKey(String(value))}
								className="flex flex-wrap gap-3"
							>
								{sizes.map((size) => (
									<Label
										key={size.key}
										className="border-border has-[[data-checked]]:border-primary flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-4"
									>
										<RadioGroupItem value={size.key} />
										<bdi>{size.label}</bdi>
									</Label>
								))}
							</RadioGroup>
							<p className="text-muted-foreground text-sm">
								{_(
									msg`The Canva page must be this size. Bleed around it is fine (Canva: File, Settings, Show print bleed).`,
								)}
							</p>
						</FieldSet>

						<Field className="max-w-md">
							<FieldLabel htmlFor="canva-name">{_(msg`Name`)}</FieldLabel>
							<Input
								id="canva-name"
								name="name"
								value={name}
								onChange={(event) => {
									setName(event.target.value)
									setNameEdited(true)
								}}
								maxLength={120}
								required
							/>
						</Field>

						<Button type="submit" disabled={busy || !chosen || !name.trim()}>
							{busy ? _(msg`Importing from Canva…`) : _(msg`Import design`)}
						</Button>
					</Form>
				</>
			)}
		</div>
	)
}
