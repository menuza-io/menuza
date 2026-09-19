'use client'

import { Trans } from '@lingui/macro'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageTitle } from '@repo/ui/page-title'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useState } from 'react'
import { Form, useLoaderData, useNavigation } from 'react-router'

import { type loader } from './menu.tsx'

function formatScopeLabel(operatorContext: 'brand' | 'branch') {
	if (operatorContext === 'branch') {
		return (
			<Trans>Branch menu — changes apply to the selected location only.</Trans>
		)
	}
	return (
		<Trans>
			Brand menu — editing the default location catalog (shared template until
			per-branch overrides ship).
		</Trans>
	)
}

export default function MenuBuilderPage() {
	const { menu, menuLocationId, operatorContext, canEditMenu } =
		useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'
	const [itemCategoryId, setItemCategoryId] = useState('')

	return (
		<div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 py-8 md:px-6 lg:px-8">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<PageTitle
					title="Menu"
					description="Categories, items, and pricing for your restaurant catalog."
				/>
				<Badge variant="secondary">
					{operatorContext === 'brand' ? (
						<Trans>Brand context</Trans>
					) : (
						<Trans>Branch context</Trans>
					)}
				</Badge>
			</div>
			<p className="text-muted-foreground text-sm">
				{formatScopeLabel(operatorContext)}
			</p>

			<AnnotatedLayout>
				<AnnotatedSection
					title="Catalog"
					description="How diners browse your menu on the storefront (modifiers and 86ing in a later phase)."
				>
					{menu.categories.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No categories yet. Add your first category below.</Trans>
						</p>
					) : (
						<div className="flex flex-col gap-4">
							{menu.categories.map((category) => (
								<div
									key={category.id}
									className="rounded-lg border p-4 shadow-xs"
								>
									<div className="flex items-center justify-between gap-2">
										<h3 className="font-medium">{category.name}</h3>
										{!category.active ? (
											<Badge variant="outline">
												<Trans>Hidden</Trans>
											</Badge>
										) : null}
									</div>
									{category.items.length === 0 ? (
										<p className="text-muted-foreground mt-2 text-sm">
											<Trans>No items in this category.</Trans>
										</p>
									) : (
										<ul className="mt-3 divide-y text-sm">
											{category.items.map((item) => (
												<li
													key={item.id}
													className="flex items-center justify-between gap-4 py-2"
												>
													<span>
														{item.name}
														{!item.active ? (
															<span className="text-muted-foreground">
																{' '}
																(<Trans>86&apos;d</Trans>)
															</span>
														) : null}
													</span>
													<span className="tabular-nums">
														${(item.priceCents / 100).toFixed(2)}
													</span>
												</li>
											))}
										</ul>
									)}
								</div>
							))}
						</div>
					)}
				</AnnotatedSection>

				{canEditMenu ? (
					<AnnotatedSection
						title="Add to menu"
						description="Create categories and items for the current location scope."
					>
						<div className="grid gap-6 md:grid-cols-2">
							<Form method="post" className="flex flex-col gap-4">
								<input type="hidden" name="intent" value="create-category" />
								<p className="font-medium">
									<Trans>New category</Trans>
								</p>
								<div className="space-y-1">
									<Label htmlFor="category-name">
										<Trans>Name</Trans>
									</Label>
									<Input id="category-name" name="name" required />
								</div>
								<Button type="submit" disabled={isSubmitting}>
									<Trans>Add category</Trans>
								</Button>
							</Form>

							<Form method="post" className="flex flex-col gap-4">
								<input type="hidden" name="intent" value="create-item" />
								<input type="hidden" name="categoryId" value={itemCategoryId} />
								<p className="font-medium">
									<Trans>New item</Trans>
								</p>
								<div className="space-y-1">
									<Label htmlFor="item-category">
										<Trans>Category</Trans>
									</Label>
									<Select
										value={itemCategoryId}
										onValueChange={(value) => value && setItemCategoryId(value)}
									>
										<SelectTrigger id="item-category" className="w-full">
											<SelectValue placeholder="Select category" />
										</SelectTrigger>
										<SelectContent>
											{menu.categories.map((category) => (
												<SelectItem key={category.id} value={category.id}>
													{category.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
								<div className="space-y-1">
									<Label htmlFor="item-name">
										<Trans>Name</Trans>
									</Label>
									<Input id="item-name" name="name" required />
								</div>
								<div className="space-y-1">
									<Label htmlFor="item-price">
										<Trans>Price (USD cents)</Trans>
									</Label>
									<Input
										id="item-price"
										name="priceCents"
										type="number"
										min={0}
										required
									/>
								</div>
								<Button
									type="submit"
									disabled={isSubmitting || menu.categories.length === 0}
								>
									<Trans>Add item</Trans>
								</Button>
							</Form>
						</div>
					</AnnotatedSection>
				) : (
					<AnnotatedSection
						title="View only"
						description="Your role can view the menu but not edit it."
					>
						<p className="text-muted-foreground text-sm">
							<Trans>
								Ask an admin to grant menu edit access or switch to a role with
								update permission.
							</Trans>
						</p>
					</AnnotatedSection>
				)}
			</AnnotatedLayout>
		</div>
	)
}
