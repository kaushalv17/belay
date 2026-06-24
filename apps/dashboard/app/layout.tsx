import "./globals.css"
import Link from "next/link"
import type { ReactNode } from "react"

export const metadata = {
	title: "Quorvel — Approvals",
	description: "Live approval queue and per-agent action timeline for Quorvel.",
}

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>
				<header className="topbar">
					<Link href="/" className="brand">
						<span className="brand-mark">Quorvel</span>
						<span className="brand-sub">control plane</span>
					</Link>
					<nav className="nav">
						<Link href="/">Approvals</Link>
						<Link href="/agents">Agents</Link>
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
	)
}
