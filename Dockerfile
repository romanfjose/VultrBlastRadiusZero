# Production Vultr Cloud Compute Container Specification for BLAST RADIUS ZERO (BRZ-0)
FROM node:22-alpine

# Create isolated non-root execution user
RUN addgroup -S brzgroup && adduser -S brzoperator -G brzgroup

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY test ./test

# Ensure strict file ownership and writable tmpdir for ephemeral sandboxes
RUN chown -R brzoperator:brzgroup /app && chmod -R 755 /app

USER brzoperator

ENV NODE_ENV=production
ENV PORT=4680

EXPOSE 4680

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:4680/api/health || exit 1

CMD ["node", "server.js"]
