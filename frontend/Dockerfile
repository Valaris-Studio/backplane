ARG PREVIOUS_FRONTEND_IMAGE=nginx:alpine
FROM ${PREVIOUS_FRONTEND_IMAGE} AS previous

FROM node:22-alpine AS builder

WORKDIR /app
ENV CI=true
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

# frontend/pnpm-lock.yaml is a standalone lockfile (the workspace one lives at
# the repo root) so this stage builds reproducibly without the root context.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --ignore-scripts mirrors CI: the bundle needs no native postinstall builds,
# and pnpm 11 otherwise hard-fails on unapproved dependency build scripts.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm build

FROM python:3.12-alpine AS retained
COPY --from=previous /usr/share/nginx/html /previous
COPY --from=builder /app/dist /current
COPY scripts/retain-assets.py /retain-assets.py
RUN python /retain-assets.py /current /retained --previous /previous

FROM nginx:alpine
RUN apk add --no-cache python3
COPY --from=retained /retained /usr/share/nginx/html/.asset-history
COPY scripts/retain-assets.py /usr/local/bin/retain-assets.py
COPY scripts/start-frontend.sh /usr/local/bin/start-frontend.sh
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf.template
EXPOSE 8080
CMD ["/bin/sh", "/usr/local/bin/start-frontend.sh"]
