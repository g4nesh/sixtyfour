# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS verifier
COPY . .
RUN npm run verify

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=verifier /app/package.json /app/package-lock.json ./
COPY --from=verifier /app/node_modules ./node_modules
COPY --from=verifier /app/dist ./dist
COPY --from=verifier /app/.openai ./.openai
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
