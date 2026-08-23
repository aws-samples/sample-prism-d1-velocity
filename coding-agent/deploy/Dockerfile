# PRISM coding agent — single harness environment for every toolchain.
#
# One harness instead of one per language. The reason is a hard limit: an
# AgentCore Runtime image may not exceed 2 GB and that quota is not adjustable,
# while the official language images total ~9.3 GB (rust:1 alone is 1.65 GB, or
# 83% of the budget). A fat image is arithmetically impossible.
#
# So this image ships a version *manager* rather than versions. The toolchain is
# installed at session start with InvokeAgentRuntimeCommand -- no model
# reasoning, no tokens -- reading the target repository's own version files.
# AWS documents this path: "The base environment includes Python and bash. For
# tools like git, node, or other runtimes, install them at session start."
#
# It also closes the version matrix. node@18 and node@22 stop being two
# harnesses and become a line in the repo's .tool-versions, which suits an
# architecture where the repository already describes itself.
#
# Build (must be arm64 -- the harness rejects anything else):
#   docker buildx build --platform linux/arm64 -t prism-coding-agent:dev .
#
# The harness overrides ENTRYPOINT and CMD to keep the container alive as an
# environment, so neither is set here. Installed software, filesystem and
# environment variables are what carry over.

FROM python:3.12-slim

# Pinned rather than floated: a harness image that silently changes its tool
# manager between builds makes an agent regression untraceable.
ARG MISE_VERSION=v2026.8.11
ARG TARGETARCH

# git is the one non-negotiable addition -- an agent that cannot branch, diff or
# produce a patch is not a coding agent, and neither the harness base nor the
# slim Python image carries it.
#
# build-essential is here because it is load-bearing rather than convenient:
# node-gyp needs a compiler for native modules, and rustc needs a linker. Omit
# it and the failures appear later, inside the agent's own test run, where they
# read as the agent's fault.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        xz-utils \
        unzip \
        pkg-config \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# mise resolves per directory, which is what makes a multi-language monorepo
# work: the Node web app and the Python service each get their own versions with
# no routing decision made outside the repository.
#
# TARGETARCH is Docker's vocabulary (amd64/arm64); mise publishes x64/arm64.
# Mapping between them is not cosmetic -- a build that assumes they match
# succeeds on arm64 and fails with a bare curl exit 22 on x86, which is a
# confusing way to discover a naming mismatch.
RUN set -eux; \
    case "${TARGETARCH:-arm64}" in \
      amd64|x86_64) arch=x64 ;; \
      arm64|aarch64) arch=arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-${arch}.tar.gz"; \
    curl -fsSL "$url" -o /tmp/mise.tar.gz; \
    tar -xzf /tmp/mise.tar.gz -C /tmp; \
    install -m 0755 /tmp/mise/bin/mise /usr/local/bin/mise; \
    rm -rf /tmp/mise /tmp/mise.tar.gz; \
    mise --version

# Toolchains land outside $HOME so an EFS mount can be pointed here to cache
# them across sessions. Without that mount every run reinstalls, which is the
# main cost of this design; with it, the second run of any version is instant.
ENV MISE_DATA_DIR=/opt/mise \
    MISE_CACHE_DIR=/opt/mise/cache \
    PATH=/opt/mise/shims:/usr/local/bin:$PATH

# Trust configs from anywhere. mise otherwise refuses to read a .tool-versions
# it has not been told to trust, and in a disposable microVM cloning an
# arbitrary repository there is no prior trust to establish -- the isolation
# boundary is the VM, not the config file.
ENV MISE_TRUSTED_CONFIG_PATHS=/ \
    MISE_YES=1

RUN mkdir -p /opt/mise /workspace
WORKDIR /workspace
