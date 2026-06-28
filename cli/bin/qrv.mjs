#!/usr/bin/env node
// Quorvel CLI skeleton (Phase 5). Implements a minimal command router so the
// `qrv` binary works end-to-end; flesh out each command incrementally.

const API = process.env.QUORVEL_API_URL || "https://api.quorvel.tech"
const KEY = process.env.QUORVEL_API_KEY

async function api(method, path, body) {
	const res = await fetch(`${API}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${KEY}`,
			"content-type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	})
	if (!res.ok) {
		console.error(`error ${res.status}: ${await res.text()}`)
		process.exit(1)
	}
	return res.json()
}

function needKey() {
	if (!KEY) {
		console.error("Set QUORVEL_API_KEY first (qrv login coming soon).")
		process.exit(1)
	}
}

const [cmd, sub] = process.argv.slice(2)

switch (cmd) {
	case "usage": {
		needKey()
		console.log(JSON.stringify(await api("GET", "/v1/usage"), null, 2))
		break
	}
	case "keys": {
		needKey()
		console.log(JSON.stringify(await api("GET", "/v1/account/keys"), null, 2))
		break
	}
	case "tail": {
		needKey()
		const rows = await api("GET", "/v1/actions?limit=20")
		for (const r of rows) console.log(`${r.createdAt} ${r.status} ${r.tool}`)
		break
	}
	case "init":
		console.log("qrv init: scaffold a quorvel.config.ts (TODO)")
		break
	case "login":
		console.log("qrv login: device-code OAuth flow (TODO)")
		break
	case "deploy":
		console.log("qrv deploy: push functions to Quorvel Cloud (TODO)")
		break
	default:
		console.log(
			"qrv <command>\n\n  usage           show current usage\n  keys            list API keys\n  tail            tail recent actions\n  init            scaffold config (TODO)\n  login           authenticate (TODO)\n  deploy          deploy functions (TODO)",
		)
}
