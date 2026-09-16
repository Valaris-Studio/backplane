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

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf.template
EXPOSE 8080
CMD ["/bin/sh", "-c", "envsubst '${BACKEND_URL}' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
