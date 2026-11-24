FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
# tsx is currently a devDependency; use the repository lockfile unchanged.
RUN npm ci --include=dev --ignore-scripts

COPY keeper/keeper.ts keeper/keeper.ts
COPY shared/abi.ts shared/legacy.ts shared/listing.ts shared/
COPY deployments/1.legacy.json deployments/1.legacy.json
COPY scripts/canary-guard.ts scripts/canary-guard.ts
RUN mkdir -p /data && chmod 700 /data

ENV NODE_ENV=production
EXPOSE 8787
STOPSIGNAL SIGTERM
CMD ["npm", "run", "keeper"]
