# Codex App Server on Kubernetes — Architecture & Security Review

> Production-ready reference architecture for running OpenAI Codex App Server
> on Kubernetes with Agent Sandbox isolation, SPIFFE/SPIRE workload identity,
> Cilium network enforcement, and full supply chain security controls.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Component Breakdown](#2-component-breakdown)
3. [Runtime Isolation — Kata Containers](#3-runtime-isolation--kata-containers)
4. [Workload Identity — SPIFFE/SPIRE](#4-workload-identity--spiffespire)
5. [Network Security — Cilium](#5-network-security--cilium)
6. [Skills at Runtime](#6-skills-at-runtime)
7. [Supply Chain Security](#7-supply-chain-security)
8. [Security Review](#8-security-review)
9. [Threat Model Summary](#9-threat-model-summary)
10. [Operational Runbook](#10-operational-runbook)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  GitHub Actions CI/CD Pipeline                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ Checkov  │→ │  Build   │→ │  Trivy   │→ │  cosign  │→ │  syft    │ │
│  │ IaC scan │  │ (Buildx) │  │  scan    │  │  sign    │  │  SBOM    │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │
│                                                      ↓ SLSA provenance  │
│                                               Sigstore Rekor Log        │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ push signed image + SBOM attestation
                               ▼
┌─────────────────────── Kubernetes Cluster ──────────────────────────────┐
│                                                                         │
│  ┌─────────────────── Namespace: spire ──────────────────────────────┐  │
│  │  SPIRE Server (StatefulSet)  ←→  SPIRE Agent (DaemonSet)         │  │
│  │  Issues X.509 SVIDs via Workload API Unix socket                  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                               │ /run/spire/sockets/agent.sock           │
│                               ▼                                         │
│  ┌─────────────────── Namespace: codex-agents ───────────────────────┐  │
│  │                                                                   │  │
│  │  ┌──────────────────────────────────────────────────────────────┐ │  │
│  │  │  Pod: codex-app-server (runtimeClassName: kata-qemu)         │ │  │
│  │  │  ┌────────────────────────────────────────────────────────┐  │ │  │
│  │  │  │  QEMU/KVM micro-VM boundary (Kata Containers)          │  │ │  │
│  │  │  │                                                        │  │ │  │
│  │  │  │  init: spire-wait                                      │  │ │  │
│  │  │  │  ├── waits for /run/spire/sockets/agent.sock           │  │ │  │
│  │  │  │                                                        │  │ │  │
│  │  │  │  container: codex-app-server                           │  │ │  │
│  │  │  │  ├── image: cgr.dev/chainguard/node@sha256:...         │  │ │  │
│  │  │  │  ├── UID 65532 (nonroot)                               │  │ │  │
│  │  │  │  ├── readOnlyRootFilesystem: true                      │  │ │  │
│  │  │  │  ├── capabilities: drop ALL                            │  │ │  │
│  │  │  │  ├── /skills (ConfigMap, RO) ← Codex discovers here    │  │ │  │
│  │  │  │  ├── /run/spire/sockets (hostPath, RO) ← SVID         │  │ │  │
│  │  │  │  └── /tmp (emptyDir, Memory)                           │  │ │  │
│  │  │  └────────────────────────────────────────────────────────┘  │ │  │
│  │  └──────────────────────────────────────────────────────────────┘ │  │
│  │                                                                   │  │
│  │  Kyverno Admission Controller enforces:                           │  │
│  │  ✓ runtimeClassName: kata-qemu                                    │  │
│  │  ✓ image digest pinned (@sha256:...)                               │  │
│  │  ✓ cosign signature verified (keyless, Rekor)                     │  │
│  │  ✓ SBOM attestation present (CycloneDX)                           │  │
│  │  ✓ readOnlyRootFilesystem: true                                   │  │
│  │  ✓ allowPrivilegeEscalation: false                                │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  Cilium Network Enforcement:                                            │
│  ✓ Default deny ALL (ingress + egress) in codex-agents                  │
│  ✓ Allow egress → SPIRE Server :8081 (in-cluster)                       │
│  ✓ Allow egress → api.openai.com :443 (FQDN)                            │
│  ✓ Allow egress → approved MCP FQDNs :443                               │
│  ✓ Allow egress → kube-dns :53 (cluster.local only)                     │
│  ✗ All other egress blocked                                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component Breakdown

| Component | Technology | Purpose |
|---|---|---|
| App Server | Codex App Server (OpenAI) | JSON-RPC 2.0 agent interface, conversation history, approvals, streamed events |
| Isolation Runtime | Kata Containers (QEMU/KVM) | Per-pod micro-VM boundary; agents cannot escape to host kernel |
| Workload Identity | SPIFFE/SPIRE | Cryptographically attested X.509 SVIDs; no static secrets for service identity |
| Network Policy | Cilium CiliumNetworkPolicy | FQDN-aware L7 egress control; default-deny posture |
| Admission Control | Kyverno | Policy enforcement at admission: digest, signature, SBOM, RuntimeClass, pod security |
| Image Supply Chain | Chainguard + cosign + syft | Distroless hardened images, keyless signing, CycloneDX SBOM attestation |
| Provenance | SLSA Level 3 | Build provenance recorded to Sigstore Rekor transparency log |
| Digest Automation | Renovate Bot | Weekly PRs to update pinned digests when new Chainguard images are published |
| IaC Scanning | Checkov | SARIF-output Kubernetes manifest scanning in CI |
| Vulnerability Scanning | Trivy | Container image CVE scan; blocks pipeline on HIGH/CRITICAL |

---

## 3. Runtime Isolation — Kata Containers

### Why Kata?

Standard container isolation shares the host kernel. A container escape in a traditional runc pod gives an attacker host kernel access. Kata Containers run each pod inside a lightweight QEMU/KVM micro-VM, providing a hardware-enforced boundary.

For AI agents executing arbitrary code and making autonomous API calls, this boundary is essential — even if the agent is compromised or manipulated, it cannot break out to the host or other pods.

### Configuration

```yaml
runtimeClassName: kata-qemu
```

This single field in the pod spec causes the kubelet to use `containerd-shim-kata-v2` instead of `containerd-shim-runc-v2`. The pod runs in a guest kernel with virtio-based I/O.

**Node prerequisite:** Nodes must run `katacontainers.io/kata-runtime: "true"` taint/label. The RuntimeClass `scheduling.nodeSelector` ensures pods only land on Kata-capable nodes.

**Kyverno enforcement:** `require-kata-runtimeclass` policy blocks any pod in `codex-agents` that omits `runtimeClassName: kata-qemu`, preventing accidental runc fallback.

---

## 4. Workload Identity — SPIFFE/SPIRE

### Why SPIFFE/SPIRE?

Kubernetes service accounts with JWT tokens are mutable and often over-permissioned. SPIFFE/SPIRE provides short-lived, automatically rotated X.509 SVIDs (SPIFFE Verifiable Identity Documents) that:

- Are cryptographically bound to the workload's identity (namespace + SA + pod UID)
- Are attested by the node agent using Projected Service Account Tokens (PSAT)
- Expire in 1 hour and are automatically renewed by the SPIRE agent
- Can be used for mutual TLS (mTLS) to MCP servers without static certificates

### SVID Flow

```
1. SPIRE Server starts → establishes trust domain: cluster.local
2. SPIRE Agent daemonset starts on each node → attests to SPIRE Server via PSAT
3. Codex pod starts → init container waits for agent.sock to appear
4. SPIRE Agent attests the pod (namespace + SA + container ID via kubelet API)
5. ClusterSPIFFEID rule matches → SVID issued to pod:
   spiffe://cluster.local/ns/codex-agents/sa/codex-agent
6. Pod fetches SVID via Workload API at unix:///run/spire/sockets/agent.sock
7. SVID rotates automatically before TTL expiry (1h)
```

### MCP Server mTLS

Codex uses the SVID to establish mTLS with approved MCP servers. The MCP server verifies the SPIFFE ID against its trust bundle — only pods with the correct SPIFFE ID can connect. No static API keys or certificates need to be distributed.

---

## 5. Network Security — Cilium

### Posture

All pods in `codex-agents` start with **zero connectivity** — both ingress and egress are denied by `default-deny-all`. Connectivity is explicitly granted by subsequent policies.

### Egress Allowlist

| Destination | Port | Protocol | Policy |
|---|---|---|---|
| SPIRE Server (`spire` ns) | 8081 | TCP | `allow-spire-egress` |
| `api.openai.com` | 443 | TCP | `allow-openai-egress` |
| `mcp.internal.example.com` | 443 | TCP | `allow-mcp-egress` |
| `exec.mcp.internal.example.com` | 443 | TCP | `allow-mcp-egress` |
| `kube-dns` (`kube-system`) | 53 | UDP/TCP | `allow-dns-egress` |

**FQDN-based policies** mean Cilium intercepts DNS responses and builds IP-based allow rules dynamically. If an MCP server changes IPs, the policy follows. Agents cannot connect to arbitrary IPs by resolving DNS — only declared FQDNs are allowed.

### Why Not Standard Kubernetes NetworkPolicy?

Kubernetes `NetworkPolicy` is IP-based and has no FQDN awareness. Cilium's `CiliumNetworkPolicy` provides:
- FQDN matching (`toFQDNs`)
- L7 protocol awareness (DNS filtering to `*.cluster.local` only)
- Identity-based (uses Cilium endpoint labels, not just IPs)
- Egress observability via Hubble for audit trail

---

## 6. Skills at Runtime

Skills are YAML definitions stored in a `ConfigMap` (`codex-skills`) and mounted read-only at `/skills` inside every agent pod.

```
/skills/
├── web-search.yaml       # Tool definitions for web search MCP
└── code-execution.yaml   # Tool definitions for code execution MCP
```

At startup, Codex App Server scans `CODEX_SKILLS_DIR=/skills` and registers each skill's tools. Adding a new skill requires only a `kubectl apply` to update the ConfigMap — no image rebuild, no pod restart (with a rolling update or `subPath` hotplug).

**Security properties:**
- `defaultMode: 0440` — read-only, no execute bit
- ConfigMap data is stored in etcd — enable etcd encryption at rest
- Skills cannot be modified by the agent at runtime (read-only filesystem + read-only volume)

---

## 7. Supply Chain Security

### Defense in Depth Model

```
Source → Build → Sign → Attest → Admit → Run
  ↑         ↑       ↑       ↑        ↑       ↑
Checkov  Buildx  cosign   syft   Kyverno  Kata+RO
IaC scan pinned  keyless  SBOM   digest   FS
         digest  Rekor    attest  verify
```

### Controls at Each Stage

#### Source
- IaC manifests scanned by Checkov in CI (SARIF → GitHub Security tab)
- Branch protection on `main` — PRs required, status checks must pass

#### Build
- Multi-stage Dockerfile: dev tooling stays in builder stage
- Final image: `cgr.dev/chainguard/node` — distroless, no shell, no package manager
- Digest pinned in Dockerfile and all Kubernetes manifests
- `docker buildx` with `--provenance=true --sbom=true` for BuildKit-native metadata

#### Sign
- `cosign sign` with OIDC keyless signing (no key management) — GitHub Actions OIDC token
- Signature recorded to Sigstore Rekor public transparency log
- Verifiable by anyone with the GitHub repo URL and cosign CLI

#### Attest (SBOM)
- `syft` generates CycloneDX JSON SBOM of all packages in the image
- SBOM attached to the image as a cosign attestation (`cosign attest --type cyclonedx`)
- Also generates SPDX format for compliance use cases
- Artifact uploaded to GitHub Actions for 90-day retention

#### Provenance (SLSA Level 3)
- `slsa-github-generator` generates SLSA Build Level 3 provenance
- Provenance records: repo, commit SHA, workflow, runner, build inputs
- Attached to image as cosign attestation in Rekor

#### Admission
- **Kyverno `require-image-digest`** — blocks tag-only references
- **Kyverno `verify-image-signature`** — verifies cosign signature against Rekor; blocks unsigned images
- **Kyverno `verify-sbom-attestation`** — verifies CycloneDX SBOM attestation is present
- **Kyverno `require-kata-runtimeclass`** — blocks pods without Kata isolation
- **Kyverno `require-readonly-rootfs`** — blocks containers with writable root filesystems
- **Kyverno `disallow-privilege-escalation`** — blocks privilege escalation

#### Runtime
- Kata micro-VM boundary — agent execution isolated from host kernel
- Read-only root filesystem — agent cannot modify its own image
- `emptyDir: {medium: Memory}` for `/tmp` — ephemeral, not persisted to disk
- No `automountServiceAccountToken` — SPIRE SVID is the only identity

#### Continuous
- Renovate bot opens weekly PRs with updated Chainguard image digests
- Trivy scan in CI blocks on HIGH/CRITICAL CVEs
- Kyverno audit mode (`background: true`) scans existing pods for drift

---

## 8. Security Review

### Strengths

| Control | Assessment |
|---|---|
| VM-level isolation (Kata) | Strong — hardware-enforced kernel boundary; container escape is contained to guest VM |
| Workload identity (SPIFFE/SPIRE) | Strong — short-lived SVIDs, automatic rotation, no static secrets |
| Network policy (Cilium default-deny) | Strong — FQDN-aware, L7 DNS filtering, zero implicit connectivity |
| Supply chain (Chainguard + cosign + syft) | Strong — distroless base, keyless signing, SBOM attestation, SLSA L3 |
| Admission control (Kyverno) | Strong — enforced at API server; no policy bypass possible at deploy time |
| Pod security (PSS Restricted) | Strong — Pod Security Standards `restricted` enforced at namespace level |

### Residual Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Agent prompt injection leading to malicious API calls | Medium | Cilium egress allowlist limits blast radius to declared FQDNs only |
| Compromised Chainguard image upstream | Low | Renovate + Trivy scan detects CVEs; cosign verifies Chainguard's own signatures |
| SPIRE server compromise | Low | SPIRE runs in isolated namespace; its own pods use restricted PSS; no agent can write to SPIRE server |
| Kata QEMU CVE | Low | Chainguard kata-agent image; Renovate digest updates; Trivy scanning |
| etcd secret exposure (OPENAI_API_KEY) | Low | Enable etcd encryption at rest; use ExternalSecrets operator (Vault/GCP Secret Manager) for production |
| Kyverno policy bypass via CRD tampering | Very Low | Restrict CRD write access via RBAC; use Kyverno's own webhook TLS verification |

### Recommended Enhancements for Production

1. **External Secrets Operator** — Replace the `codex-api-credentials` Secret with ESO backed by GCP Secret Manager or HashiCorp Vault. Eliminates secrets at rest in etcd.

2. **Hubble Observability** — Enable Cilium Hubble for network flow audit logs. Feed into your SIEM for egress anomaly detection.

3. **OPA/Gatekeeper for SLSA Policy** — Enforce minimum SLSA build level via OPA constraints as a complement to Kyverno.

4. **Falco Runtime Detection** — Deploy Falco alongside Kata to detect anomalous syscall patterns inside the micro-VM guest kernel.

5. **Cosign Policy Controller** — Replace Kyverno image verification with Sigstore's dedicated Policy Controller for more granular image admission rules.

6. **NetworkPolicy + CiliumNetworkPolicy Dual Enforcement** — Apply standard Kubernetes NetworkPolicy alongside Cilium policies for defense-in-depth in case of Cilium misconfiguration.

7. **Node hardening** — Use Bottlerocket or CoreOS on Kata-capable nodes; apply CIS Kubernetes Benchmark node configs via Ansible/Terraform.

---

## 9. Threat Model Summary

### STRIDE Analysis

| Threat | Vector | Control |
|---|---|---|
| **Spoofing** | Agent impersonates another service | SPIFFE/SPIRE — cryptographic SVID required for mTLS |
| **Tampering** | Image modified after build | cosign signature + digest pin — Kyverno blocks tampered images |
| **Repudiation** | Build provenance disputed | SLSA L3 provenance in Rekor — immutable audit trail |
| **Information Disclosure** | Agent reads neighbor pod data | Kata micro-VM — no shared memory/kernel with other pods |
| **Denial of Service** | Agent exhausts node resources | Resource requests/limits in Deployment; pod disruption budget |
| **Elevation of Privilege** | Container escape to host | Kata QEMU boundary + `allowPrivilegeEscalation: false` + drop ALL caps |

---

## 10. Operational Runbook

### Deploy Order

```bash
# 1. Install Kata Containers on nodes (varies by distro)
# 2. Install Cilium with Hubble
helm install cilium cilium/cilium --namespace kube-system \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true

# 3. Install Kyverno
helm install kyverno kyverno/kyverno --namespace kyverno --create-namespace

# 4. Deploy SPIRE
kubectl apply -f spire/

# 5. Deploy supply-chain policies
kubectl apply -f supply-chain/

# 6. Deploy namespace + network policies
kubectl apply -f manifests/namespace.yaml
kubectl apply -f network/

# 7. Create API key secret
kubectl create secret generic codex-api-credentials \
  --namespace codex-agents \
  --from-literal=openai-api-key='sk-...'

# 8. Deploy app
kubectl apply -f manifests/
```

### Verify SPIRE SVID

```bash
kubectl exec -n codex-agents deploy/codex-app-server -- \
  /spire-agent/bin/spire-agent api fetch x509 \
  -socketPath /run/spire/sockets/agent.sock
```

### Verify cosign signature

```bash
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp "https://github.com/rajesamp/codex-app-server-k8s/.*" \
  ghcr.io/rajesamp/codex-app-server@sha256:<digest>
```

### Verify SBOM attestation

```bash
cosign verify-attestation \
  --type cyclonedx \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp "https://github.com/rajesamp/.*" \
  ghcr.io/rajesamp/codex-app-server@sha256:<digest>
```

### Add a new skill

```bash
# Edit the ConfigMap and apply
kubectl edit configmap codex-skills -n codex-agents
# Or apply a patched version:
kubectl apply -f manifests/skills-configmap.yaml
# Codex picks up the new skill on next reconciliation (no pod restart needed)
```
