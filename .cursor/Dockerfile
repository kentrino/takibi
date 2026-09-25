ARG NODE_IMAGE=node:22.23.2-bookworm-slim
FROM ${NODE_IMAGE}

ENV CI=1
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable
