FROM node:22-bookworm-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

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
