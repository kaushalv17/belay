# Infra-as-code skeleton (Phase 8). This is a STARTING POINT, not a turnkey
# apply: fill in provider credentials and uncomment resources as you adopt each
# managed service. Keeps environments reproducible (staging vs production).

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    # neon = { source = "kislerdm/neon", version = "~> 0.6" }
    # vercel = { source = "vercel/vercel", version = "~> 1.0" }
    # render = { source = "render-oss/render", version = "~> 1.0" }
  }
  # Recommended: remote state in a bucket so the team shares one source of truth.
  # backend "s3" { bucket = "quorvel-tfstate" key = "prod/terraform.tfstate" region = "us-east-1" }
}

variable "environment" {
  type    = string
  default = "production"
}

# Example resource stubs (uncomment + configure provider first):
#
# resource "neon_project" "main" {
#   name = "quorvel-${var.environment}"
# }
#
# resource "render_web_service" "api" {
#   name        = "quorvel-api-${var.environment}"
#   plan        = "starter"
#   runtime     = "node"
#   repo_url    = "https://github.com/kaushalv17/Quorvel"
#   root_dir    = "apps/api"
#   build_command = "pnpm install --frozen-lockfile && pnpm build"
#   start_command = "node dist/index.js"
# }

output "environment" {
  value = var.environment
}
