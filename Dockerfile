# Stage 1: build TypeScript -> JS
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: slim runtime image — no dev deps, no source, no build tools
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# tsx (used by `npm run db:migrate`) is a devDependency, so it is NOT
# installed here. Migrations in this image must run the compiled copy:
#   node dist/database/migrate.js   ->  npm run db:migrate:prod
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
# migrate.js resolves this path relative to the working directory.
COPY --from=builder /app/src/database/migrations ./src/database/migrations
EXPOSE 3000
# Migrations are run by the platform's pre-deploy/release command, not
# here — running them inside CMD races when more than one instance boots.
CMD ["node", "dist/main.js"]
