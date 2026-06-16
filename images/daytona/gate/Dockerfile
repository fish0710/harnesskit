FROM daytonaio/sandbox:0.5.0-slim

ARG NODE_VERSION=22.14.0

USER root

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      python3; \
    rm -rf /var/lib/apt/lists/*; \
    node_bin="/usr/local/nvm/versions/node/v${NODE_VERSION}/bin"; \
    test -x /usr/bin/bash; \
    test -x "${node_bin}/node"; \
    test -x "${node_bin}/npm"; \
    test -x "${node_bin}/npx"; \
    ln -sf "${node_bin}/node" /usr/local/bin/node; \
    ln -sf "${node_bin}/npm" /usr/local/bin/npm; \
    ln -sf "${node_bin}/npx" /usr/local/bin/npx; \
    test "$(node --version)" = "v${NODE_VERSION}"; \
    python3 --version; \
    curl --version

ENV PATH="/usr/local/bin:/usr/local/nvm/versions/node/v22.14.0/bin:${PATH}"

USER daytona
