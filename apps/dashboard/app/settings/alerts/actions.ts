"use server"

import { revalidatePath } from "next/cache"
import { serverClient } from "../../../lib/server-client"
import type { AlertTrigger } from "../../../lib/quorvel"

const TRIGGERS = new Set<AlertTrigger>(["awaiting_approval", "denied", "failed"])

function parseChannels(raw: string): string[] {
    return raw
        .split(/[,\s]+/)
        .map((c) => c.trim())
        .filter(Boolean)
}

export async function createAlertRuleAction(formData: FormData): Promise<void> {
    const name = String(formData.get("name") ?? "").trim()
    const trigger = String(formData.get("trigger") ?? "") as AlertTrigger
    const scopeRaw = String(formData.get("scope") ?? "").trim()
    const channels = parseChannels(String(formData.get("channels") ?? ""))
    if (!name || !TRIGGERS.has(trigger)) return
    await serverClient().createAlertRule({ name, trigger, scope: scopeRaw || null, channels })
    revalidatePath("/settings/alerts")
}

export async function toggleAlertRuleAction(formData: FormData): Promise<void> {
    const id = String(formData.get("id") ?? "")
    if (!id) return
    const enabled = String(formData.get("enabled") ?? "") === "true"
    await serverClient().updateAlertRule(id, { enabled })
    revalidatePath("/settings/alerts")
}

export async function deleteAlertRuleAction(formData: FormData): Promise<void> {
    const id = String(formData.get("id") ?? "")
    if (!id) return
    await serverClient().deleteAlertRule(id)
    revalidatePath("/settings/alerts")
}