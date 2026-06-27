# syntax=docker/dockerfile:1

# Production image for the MagickUtils Next.js app.
# Multi-stage build on Node 24, emitting Next.js standalone output for a small,
# non-root runtime image.
#
# Build:
#   docker build -t magick-utils \
#     --build-arg NEXT_PUBLIC_FIREBASE_API_KEY=... \
#     --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=... \
#     --build-arg NEXT_PUBLIC_FIREBASE_PROJECT_ID=... \
#     --build-arg NEXT_PUBLIC_FIREBASE_APP_ID=... .
#
# Run (server-only secrets are supplied at runtime, never baked in):
#   docker run -p 3000:3000 --env-file .env.local magick-utils

# ---- Base -------------------------------------------------------------------
FROM node:24-alpine AS base
# libc6-compat: some Next.js/native deps expect glibc symbols on Alpine (musl).
RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- Dependencies -----------------------------------------------------------
FROM base AS deps
# Copy only the manifests first so this layer is cached unless they change.
COPY package.json package-lock.json ./
RUN npm ci

# ---- Builder ----------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the client bundle during `next build`,
# so they must be present at build time (not just at runtime). Supply via
# --build-arg; if omitted the app builds fine but Firebase login is disabled.
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ENV NEXT_PUBLIC_FIREBASE_API_KEY=${NEXT_PUBLIC_FIREBASE_API_KEY} \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN} \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=${NEXT_PUBLIC_FIREBASE_PROJECT_ID} \
    NEXT_PUBLIC_FIREBASE_APP_ID=${NEXT_PUBLIC_FIREBASE_APP_ID}

RUN npm run build

# ---- Runner -----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Run as an unprivileged user.
RUN addgroup -g 1001 -S nodejs \
 && adduser -u 1001 -S nextjs -G nodejs

# Standalone output bundles a minimal server.js plus only the traced node_modules.
# Static assets and the public/ dir must be copied alongside it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Brand packs (whitelabeling). The loader reads brands/<id>/ at runtime via a
# dynamic path, which the standalone tracer can't follow — copy the dir in
# explicitly so every committed brand ships in the image. To add a brand WITHOUT
# rebuilding, bind-mount a host brands/ dir over /app/brands and set BRAND=<id>
# (see docker-compose.yml).
COPY --from=builder --chown=nextjs:nodejs /app/brands ./brands

USER nextjs
EXPOSE 3000

# Liveness probe against the unauthenticated /api/health route (uses Node 24's
# built-in global fetch — no curl needed in the image).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
