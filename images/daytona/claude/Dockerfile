FROM daytonaio/sandbox:0.5.0-slim

ARG NODE_VERSION=22.14.0
ARG CLAUDE_CODE_VERSION=2.1.145

USER root

RUN set -eux; \
    node_bin="/usr/local/nvm/versions/node/v${NODE_VERSION}/bin"; \
    claude_prefix="/opt/claude-code"; \
    test -x "${node_bin}/node"; \
    test -x "${node_bin}/npm"; \
    test -x "${node_bin}/npx"; \
    ln -sf "${node_bin}/node" /usr/local/bin/node; \
    ln -sf "${node_bin}/npm" /usr/local/bin/npm; \
    ln -sf "${node_bin}/npx" /usr/local/bin/npx; \
    npm install --global --prefix "${claude_prefix}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
    ln -sf "${claude_prefix}/bin/claude" /usr/local/bin/claude; \
    test "$(node --version)" = "v${NODE_VERSION}"; \
    test "$(claude --version | awk '{print $1}')" = \
      "${CLAUDE_CODE_VERSION}"

ENV PATH="/usr/local/bin:/usr/local/nvm/versions/node/v22.14.0/bin:${PATH}"

USER daytona
