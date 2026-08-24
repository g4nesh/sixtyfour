# syntax=docker/dockerfile:1.7
FROM node:22.13-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS verifier
COPY . .
RUN npm run verify

FROM node:22.13-alpine AS runner
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
COPY --from=verifier /app/package.json /app/package-lock.json ./
COPY --from=verifier /app/node_modules ./node_modules
COPY --from=verifier /app/dist ./dist
COPY --from=verifier /app/.openai ./.openai
COPY --from=verifier /app/scripts/container-entrypoint.mjs ./scripts/container-entrypoint.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/api/health').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "scripts/container-entrypoint.mjs"]
