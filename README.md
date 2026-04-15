# Codex App Server on Kubernetes

> Self-hosted [OpenAI Codex App Server](https://developers.openai.com/codex/app-server) running on Kubernetes with [Agent Sandbox](https://sigs.k8s.io/agent-sandbox) — Kata Containers isolation, SPIFFE/SPIRE workload identity, Cilium default-deny egress, and full supply chain security. Your agents, your infrastructure, your terms.

![CI](https://github.com/rajesamp/codex-app-server-k8s/actions/workflows/build-sign-sbom.yaml/badge.svg?branch=main)

---

## What This Is

This repo gives you Claude-style managed agents on your own Kubernetes cluster:

| Capability | Implementation |
|---|---|
| Agent runtime | Codex App Server (JSON-RPC 2.0, streaming, approvals) |
| Per-agent isolation | Kata Containers — QEMU/KVM micro-VM per pod |
| Workload identity | SPIFFE/SPIRE — X.509 SVIDs, 1h TTL, auto-rotation |
| Network control | Cilium — default-deny + FQDN-scoped egress allowlist |
| Skill discovery | ConfigMap volume mount at `/skills` — no image rebuild |
| Image supply chain | Chainguard distroless + cosign keyless signing + syft SBOM |
| Provenance | SLSA Build Level 3 via slsa-github-generator |
| Admission enforcement | Kyverno — digest, signature, SBOM, RuntimeClass, pod security |

---

## CI Pipeline

The `Build, Sign, SBOM & Provenance` workflow runs on every push to `main` and can be triggered manually from the Actions tab. All 8 jobs must pass for a release to be considered production-ready.

| Job | What It Does | Must Pass |
|---|---|---|
| IaC Security Scan (Checkov) | Scans `manifests/` — 104 Kubernetes checks, 0 failures | Yes |
| Build & Push Image | Multi-stage Chainguard build, pushed to GHCR with digest | Yes |
| Trivy Vulnerability Scan | Scans the pushed image — blocks on HIGH/CRITICAL CVEs | Yes |
| Sign Image (cosign keyless) | OIDC keyless signature recorded to Sigstore Rekor | Yes |
| Generate SBOM | CycloneDX + SPDX via syft, attached as cosign attestation | Yes |
| Generate SLSA Provenance | SLSA Build Level 3 provenance via slsa-github-generator | Yes |

SARIF results from Checkov and Trivy are uploaded to the **Security → Code scanning** tab (GitHub Advanced Security, enabled on this public repo) and also saved as downloadable workflow artifacts for 90 days.

### Notes from CI hardening

A number of issues were resolved during initial CI bring-up — documented here so contributors understand the constraints:

- **Checkov (CKV_K8S_10/11/12/13)** — Resource requests and limits are required on init containers as well as main containers. The `spire-wait` init container has its own `resources` block.
- **Checkov (CKV_K8S_35)** — Secrets must be mounted as files, not injected as environment variables. `OPENAI_API_KEY` is projected as a volume at `/run/secrets/openai-api-key` (mode `0400`) and read via `OPENAI_API_KEY_FILE`.
- **Checkov (CKV2_K8S_6)** — A standard `NetworkPolicy` must exist alongside `CiliumNetworkPolicy` for Checkov to recognise network coverage. `manifests/networkpolicy.yaml` mirrors the Cilium posture at the Kubernetes API level; both enforce simultaneously.
- **SARIF upload** — `github/codeql-action/upload-sarif` requires GitHub Advanced Security. On private repos this step is marked `continue-on-error: true` with an artifact fallback. On this public repo GHAS is active and the upload succeeds.
- **Trivy action tag** — The correct pinned tag format is `aquasecurity/trivy-action@v0.35.0` (with `v` prefix). `@0.28.0` without the prefix does not resolve.
- **Image digests** — All `cgr.dev/chainguard/*` references use real SHA256 digests pinned at build time. Renovate Bot opens weekly PRs to keep them current.
- **`npm ci` requires `package-lock.json`** — A lockfile must be committed alongside `package.json`. The Dockerfile uses `--omit=dev` (replaces deprecated `--only=production`) and `mkdir -p node_modules` before `npm ci` so the builder stage always produces a `node_modules` directory for the final `COPY --from=builder` stage, even when there are zero dependencies.

---

## Quick Start

### Prerequisites

- Kubernetes cluster with Kata Containers nodes (`katacontainers.io/kata-runtime: "true"`)
- [Cilium](https://docs.cilium.io/en/stable/installation/) installed
- [Kyverno](https://kyverno.io/docs/installation/) installed
- `kubectl`, `cosign`, `syft` on your PATH

### Deploy

```bash
# 1. Clone
git clone https://github.com/rajesamp/codex-app-server-k8s.git
cd codex-app-server-k8s

# 2. Install SPIRE
kubectl apply -f spire/

# 3. Apply supply-chain admission policies
kubectl apply -f supply-chain/

# 4. Create namespace + network policies
kubectl apply -f manifests/namespace.yaml
kubectl apply -f network/

# 5. Create your OpenAI API key secret
kubectl create secret generic codex-api-credentials \
  --namespace codex-agents \
  --from-literal=openai-api-key='YOUR_KEY_HERE'

# 6. Deploy Codex App Server
kubectl apply -f manifests/
```

### Add Skills

Edit `manifests/skills-configmap.yaml` and apply:

```bash
kubectl apply -f manifests/skills-configmap.yaml
```

Codex discovers skills at runtime from `/skills` — no image rebuild, no pod restart required.

---

## Repository Structure

```
.
├── Dockerfile                          # Multi-stage, Chainguard distroless, pinned digests
├── package.json                        # Node.js manifest (skeleton — replace with your impl)
├── package-lock.json                   # Lockfile required for npm ci in Docker build
├── src/index.js                        # Skeleton server: /healthz, /readyz, skill discovery
├── renovate.json                       # Weekly Chainguard digest update PRs
├── manifests/
│   ├── namespace.yaml                  # codex-agents NS with PSS restricted
│   ├── runtimeclass-kata.yaml          # Kata QEMU RuntimeClass
│   ├── serviceaccount.yaml             # SA + empty RBAC (zero K8s API access)
│   ├── skills-configmap.yaml           # Skill definitions (mounted at /skills)
│   ├── deployment.yaml                 # Codex App Server Deployment
│   ├── networkpolicy.yaml              # Standard K8s NetworkPolicy (mirrors Cilium posture)
│   └── service.yaml                    # ClusterIP Service
├── spire/
│   ├── spire-server.yaml               # SPIRE Server StatefulSet + RBAC
│   ├── spire-agent-daemonset.yaml      # SPIRE Agent DaemonSet
│   └── clusterspiffeid.yaml            # Auto SVID assignment rule
├── network/
│   ├── default-deny-all.yaml           # Zero-trust baseline: deny all ingress+egress
│   └── codex-egress-policy.yaml        # Explicit FQDN allowlist (SPIRE, OpenAI, MCP)
├── supply-chain/
│   ├── kyverno-require-digest.yaml     # Block tag-only image refs
│   ├── kyverno-verify-image.yaml       # cosign signature + SBOM attestation verification
│   └── kyverno-restrict-runtime.yaml   # Require kata-qemu, RO rootfs, no privesc
├── .github/workflows/
│   ├── build-sign-sbom.yaml            # CI: Checkov → Build → Trivy → cosign → syft → SLSA
│   └── renovate-digest-update.yaml     # Weekly digest update automation
└── docs/
    └── ARCHITECTURE.md                 # Full architecture + security review + threat model
```

---

## Security Controls Summary

### Supply Chain (Source → Admission)

```
Checkov IaC scan → Trivy CVE block → cosign keyless sign → syft CycloneDX SBOM → SLSA L3 provenance
                                              ↓                     ↓                      ↓
                                        Rekor log            cosign attestation      Rekor log
                                              ↓
                                    Kyverno verify at admission
```

### Runtime (Admission → Execution)

| Layer | Control | Enforcement |
|---|---|---|
| Image | Chainguard distroless, no shell/pkg mgr | Dockerfile |
| Digest | SHA256 pinned in all manifests | Kyverno `require-image-digest` |
| Signature | cosign keyless (OIDC/Rekor) | Kyverno `verify-image-signature` |
| SBOM | CycloneDX cosign attestation | Kyverno `verify-sbom-attestation` |
| NetworkPolicy | Standard K8s + Cilium FQDN policies in parallel | `networkpolicy.yaml` + `network/` |
| Isolation | Kata QEMU micro-VM | Kyverno `require-kata-runtimeclass` |
| Filesystem | Read-only root, memory-backed /tmp | Kyverno `require-readonly-rootfs` |
| Privileges | No capabilities, no escalation | Kyverno `disallow-privilege-escalation` |
| Secret handling | Secrets mounted as files (mode 0400), never env vars | `deployment.yaml` |
| Identity | SPIFFE/SPIRE SVID (1h TTL, auto-rotate) | SPIRE Agent DaemonSet |

---

## Updating Image Digests

Renovate Bot opens weekly PRs with updated Chainguard image digests. Review and merge — Kyverno will enforce the new digest at next rollout.

To manually update:

```bash
# Install crane
brew install crane   # or: go install github.com/google/go-containerregistry/cmd/crane@latest

# Get latest Chainguard node digest
crane digest cgr.dev/chainguard/node:latest

# Update Dockerfile and manifests/deployment.yaml, then commit and push
kubectl apply -f manifests/deployment.yaml
```

---

## Customising for Production

Replace the skeleton `src/index.js` with your actual Codex App Server implementation. The skeleton serves `/healthz` and `/readyz` probes and reads from `CODEX_SKILLS_DIR` and `OPENAI_API_KEY_FILE` — your implementation should do the same.

Update MCP server FQDNs in `network/codex-egress-policy.yaml` to match your real MCP endpoints before deploying.

---

## References

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Kubernetes Agent Sandbox](https://sigs.k8s.io/agent-sandbox)
- [Kata Containers](https://katacontainers.io/)
- [SPIFFE/SPIRE](https://spiffe.io/)
- [Cilium Network Policies](https://docs.cilium.io/en/stable/network/kubernetes/policy/)
- [Kyverno Policies](https://kyverno.io/policies/)
- [Chainguard Images](https://www.chainguard.dev/chainguard-images)
- [cosign](https://docs.sigstore.dev/cosign/overview/)
- [syft SBOM](https://github.com/anchore/syft)
- [SLSA Framework](https://slsa.dev/)

---

## License

MIT
