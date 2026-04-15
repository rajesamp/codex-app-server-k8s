##############################################################################
# Codex App Server — Dockerfile
#
# Supply Chain Security controls:
#   - Multi-stage build: builder stage uses Chainguard Node dev image
#   - Final stage: Chainguard Node distroless (no shell, no package manager)
#   - Both stages pinned by SHA256 digest — no mutable tags in production
#   - Non-root execution enforced (UID 65532 — Chainguard nonroot default)
#   - LABEL annotations for cosign/SBOM tooling (org.opencontainers.image.*)
##############################################################################

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
# renovate: datasource=docker depName=cgr.dev/chainguard/node
FROM cgr.dev/chainguard/node:latest-dev@sha256:BUILDER_DIGEST_REPLACE_ME AS builder

WORKDIR /app

# Copy package manifests first for layer cache efficiency
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts

# Copy application source
COPY src/ ./src/

# ── Stage 2: Runtime (distroless) ────────────────────────────────────────────
# renovate: datasource=docker depName=cgr.dev/chainguard/node
FROM cgr.dev/chainguard/node@sha256:RUNTIME_DIGEST_REPLACE_ME

# OCI Annotations — used by cosign and SBOM tooling for provenance
LABEL org.opencontainers.image.source="https://github.com/YOUR_ORG/codex-app-server-k8s"
LABEL org.opencontainers.image.description="Codex App Server — agent runtime on Kubernetes"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.vendor="Your Organization"

WORKDIR /app

# Copy only production artifacts from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src

# Chainguard nonroot UID — matches runAsUser: 65532 in deployment.yaml
USER 65532

# Skills are injected at runtime via ConfigMap volume mount at /skills
# The CODEX_SKILLS_DIR env var tells Codex where to discover them.
ENV CODEX_SKILLS_DIR=/skills
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

ENTRYPOINT ["node", "src/index.js"]
