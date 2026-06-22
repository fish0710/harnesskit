FROM daytonaio/sandbox:0.5.0-slim

ARG NODE_VERSION=22.14.0
ARG LEGACY_NODE_VERSION=14.21.3

USER root

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      python3; \
    rm -rf /var/lib/apt/lists/*; \
    default_node_bin="/usr/local/nvm/versions/node/v${NODE_VERSION}/bin"; \
    legacy_node_bin="/usr/local/nvm/versions/node/v${LEGACY_NODE_VERSION}/bin"; \
    test -x /usr/bin/bash; \
    test -f /usr/local/nvm/nvm.sh; \
    LEGACY_NODE_VERSION="${LEGACY_NODE_VERSION}" bash -lc 'source /usr/local/nvm/nvm.sh && nvm install --no-progress "${LEGACY_NODE_VERSION}"'; \
    test -x "${default_node_bin}/node"; \
    test -x "${default_node_bin}/npm"; \
    test -x "${default_node_bin}/npx"; \
    test -x "${legacy_node_bin}/node"; \
    test -x "${legacy_node_bin}/npm"; \
    ln -sf "${default_node_bin}/node" /usr/local/bin/node; \
    ln -sf "${default_node_bin}/npm" /usr/local/bin/npm; \
    ln -sf "${default_node_bin}/npx" /usr/local/bin/npx; \
    test "$(node --version)" = "v${NODE_VERSION}"; \
    test "$("${legacy_node_bin}/node" --version)" = "v${LEGACY_NODE_VERSION}"; \
    test "$("${legacy_node_bin}/npm" --version)" = "6.14.18"; \
    python3 --version; \
    curl --version

ENV PATH="/usr/local/bin:/usr/local/nvm/versions/node/v${NODE_VERSION}/bin:${PATH}"

USER daytona
