import "./globals.css"
import Link from "next/link"
import type { ReactNode } from "react"
import {
	ClerkProvider,
	SignedIn,
	SignedOut,
	SignInButton,
	UserButton,
	OrganizationSwitcher,
} from "@clerk/nextjs"

export const metadata = {
	title: "Quorvel — Approvals",
	description: "Live approval queue and per-agent action timeline for Quorvel.",
}

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<ClerkProvider>
			<html lang="en">
				<body>
					<header className="topbar">
						<Link href="/" className="brand">
							<span className="brand-q">Q</span>
							<span className="brand-mark">Quorvel</span>
							<span className="brand-sub">control plane ✎</span>
						</Link>
						<nav className="nav">
							<Link href="/">Approvals</Link>
							<Link href="/agents">Agents</Link>
							<SignedIn>
								<Link href="/settings/keys">API keys</Link>
								<Link href="/settings/billing">Billing</Link>
								<Link href="/settings/members">Members</Link>
							</SignedIn>
							<SignedIn>
								<OrganizationSwitcher
									hidePersonal
									afterCreateOrganizationUrl="/"
									afterSelectOrganizationUrl="/"
								/>
								<UserButton />
							</SignedIn>
							<SignedOut>
								<SignInButton mode="modal" />
							</SignedOut>
						</nav>
					</header>
					<main className="main">{children}</main>
					<footer className="footer">
						<span className="footer-brand">Quorvel</span>
						<nav className="footer-links">
							<a href="https://quorvel.tech" target="_blank" rel="noreferrer">Home</a>
							<a href="https://quorvel.tech/terms" target="_blank" rel="noreferrer">Terms</a>
							<a href="https://quorvel.tech/privacy" target="_blank" rel="noreferrer">Privacy</a>
							<a href="https://quorvel.tech/refunds" target="_blank" rel="noreferrer">Refunds</a>
						</nav>
					</footer>
				</body>
			</html>
		</ClerkProvider>
	)
}