FROM node:22-bookworm-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm config set fetch-retries 5 \
	&& npm config set fetch-retry-factor 2 \
	&& npm config set fetch-retry-mintimeout 20000 \
	&& npm config set fetch-retry-maxtimeout 120000 \
	&& (npm ci --ignore-scripts || npm ci --ignore-scripts || npm ci --ignore-scripts)

COPY . .
RUN npm run build

ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=3000 \
	TREESEED_API_PROVIDER_AUTH=market-postgres

EXPOSE 3000

FROM runtime AS api
CMD ["npm", "run", "start:api"]

FROM runtime AS operations-runner
CMD ["npm", "run", "start:runner"]
