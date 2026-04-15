# Codex App Server on Kubernetes

> Self-hosted [OpenAI Codex App Server](https://developers.openai.com/codex/app-server) running on Kubernetes with [Agent Sandbox](https://sigs.k8s.io/agent-sandbox) — Kata Containers isolation, SPIFFE/SPIRE workload identity, Cilium default-deny egress, and full supply chain security. Your agents, your infrastructure, your terms.

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
├── renovate.json                       # Weekly Chainguard digest update PRs
├── manifests/
│   ├── namespace.yaml                  # codex-agents NS with PSS restricted
│   ├── runtimeclass-kata.yaml          # Kata QEMU RuntimeClass
│   ├── serviceaccount.yaml             # SA + empty RBAC (zero K8s API access)
│   ├── skills-configmap.yaml           # Skill definitions (mounted at /skills)
│   ├── deployment.yaml                 # Codex App Server Deployment
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
| Isolation | Kata QEMU micro-VM | Kyverno `require-kata-runtimeclass` |
| Filesystem | Read-only root, memory-backed /tmp | Kyverno `require-readonly-rootfs` |
| Privileges | No capabilities, no escalation | Kyverno `disallow-privilege-escalation` |
| Identity | SPIFFE/SPIRE SVID (1h TTL, auto-rotate) | SPIRE Agent DaemonSet |
| Networking | Default-deny + FQDN egress allowlist | Cilium CiliumNetworkPolicy |

---

## Updating Image Digests

Renovate Bot opens weekly PRs with updated Chainguard image digests. Review and merge — Kyverno will enforce the new digest at next rollout.

To manually update:

```bash
# Get latest Chainguard node digest
crane digest cgr.dev/chainguard/node:latest

# Update manifests/deployment.yaml and Dockerfile, then apply
kubectl apply -f manifests/deployment.yaml
```

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
