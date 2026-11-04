import { Trans } from '@lingui/react/macro'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Logo } from '@repo/ui/logo'
import React from 'react'
import { Form, Link } from 'react-router'
import { useOptionalUserOrganizations } from '#app/utils/organization/organizations.ts'
import { useOptionalUser } from '#app/utils/user.ts'

const menuItems = [
	{ name: 'Features', href: '#link' },
	{ name: 'Pricing', href: '/pricing' },
	{ name: 'About', href: '/about' },
]

export const HeroHeader = () => {
	const [menuState, setMenuState] = React.useState(false)
	const [isScrolled, setIsScrolled] = React.useState(false)
	const user = useOptionalUser()
	const userOrganizations = useOptionalUserOrganizations()
	const currentOrganization = userOrganizations?.currentOrganization

	React.useEffect(() => {
		const handleScroll = () => {
			setIsScrolled(window.scrollY > 50)
		}
		window.addEventListener('scroll', handleScroll)
		return () => window.removeEventListener('scroll', handleScroll)
	}, [])
	return (
		<header>
			<nav
				data-state={menuState && 'active'}
				className={cn(
					'fixed z-20 w-full transition-[background-color,border-color,backdrop-filter] duration-240',
					isScrolled &&
						'bg-background/75 border-b border-black/5 backdrop-blur-lg',
				)}
			>
				<div className="mx-auto max-w-5xl px-6">
					<div
						className={cn(
							'relative flex flex-wrap items-center justify-between gap-6 py-6 transition-[padding] duration-180 lg:gap-0',
							isScrolled && 'py-3',
						)}
					>
						<div className="flex w-full justify-between gap-6 lg:w-auto">
							<Link
								to="/"
								aria-label="home"
								className="flex items-center space-x-2"
							>
								<Logo />
							</Link>

							<button
								onClick={() => setMenuState(!menuState)}
								aria-label={menuState == true ? 'Close Menu' : 'Open Menu'}
								className="relative z-20 -m-2.5 -mr-4 block cursor-pointer p-2.5 lg:hidden"
							>
								<Icon
									name="hamburger-menu"
									className="m-auto size-6 duration-180 in-data-[state=active]:scale-0 in-data-[state=active]:rotate-180 in-data-[state=active]:opacity-0"
								/>
								<Icon
									name="x"
									className="absolute inset-0 m-auto size-6 scale-0 -rotate-180 opacity-0 duration-180 in-data-[state=active]:scale-100 in-data-[state=active]:rotate-0 in-data-[state=active]:opacity-100"
								/>
							</button>

							<div className="m-auto hidden size-fit lg:block">
								<ul className="flex gap-1">
									{menuItems.map((item, index) => (
										<li key={index}>
											<Button
												variant="ghost"
												size="sm"
												render={<Link to={item.href} className="text-base" />}
											>
												<span>{item.name}</span>
											</Button>
										</li>
									))}
								</ul>
							</div>
						</div>

						<div className="bg-background mb-6 hidden w-full flex-wrap items-center justify-end space-y-8 rounded-3xl border p-6 shadow-2xl shadow-zinc-300/20 in-data-[state=active]:block md:flex-nowrap lg:m-0 lg:flex lg:w-fit lg:gap-6 lg:space-y-0 lg:border-transparent lg:bg-transparent lg:p-0 lg:shadow-none lg:in-data-[state=active]:flex dark:shadow-none dark:lg:bg-transparent">
							<div className="lg:hidden">
								<ul className="space-y-6 text-base">
									{menuItems.map((item, index) => (
										<li key={index}>
											<Link
												to={item.href}
												className="text-muted-foreground hover:text-accent-foreground block duration-160"
											>
												<span>{item.name}</span>
											</Link>
										</li>
									))}
								</ul>
							</div>
							<div className="flex w-full flex-col space-y-3 sm:flex-row sm:gap-3 sm:space-y-0 md:w-fit">
								{!user ? (
									<>
										<Button
											variant="ghost"
											size="sm"
											className={cn(isScrolled && 'lg:hidden')}
											render={<Link to="/login" />}
										>
											<span>Login</span>
										</Button>
										<Button
											size="sm"
											className={cn(isScrolled && 'lg:hidden')}
											render={<Link to="/signup" />}
										>
											<span>
												<Trans>Sign Up</Trans>
											</span>
										</Button>
										<Button
											size="sm"
											className={cn(isScrolled ? 'lg:inline-flex' : 'hidden')}
											render={<Link to="/signup" />}
										>
											<span>
												<Trans>Get Started</Trans>
											</span>
										</Button>
									</>
								) : (
									<>
										<Form action="/logout" method="POST">
											<Button
												type="submit"
												variant="ghost"
												size="sm"
												className={cn(isScrolled && 'lg:hidden')}
											>
												<span>
													<Trans>Log out</Trans>
												</span>
											</Button>
										</Form>
										<Button
											size="sm"
											render={
												<Link
													to={
														currentOrganization
															? `/${currentOrganization.organization.slug}`
															: '/app'
													}
												/>
											}
										>
											<span>Dashboard</span>
										</Button>
									</>
								)}
							</div>
						</div>
					</div>
				</div>
			</nav>
		</header>
	)
}
