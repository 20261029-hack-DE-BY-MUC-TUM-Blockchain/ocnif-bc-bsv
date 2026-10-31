FROM node:26.13.0-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3
COPY src ./src
COPY server ./server
COPY tsconfig.json tsconfig.server.json tsconfig.server-test.json ./
RUN npm run typecheck && npm test && npm run test:server && npm audit --audit-level=high
# Compile production from a clean directory so test fixtures never ship.
RUN rm -rf dist && npm run build && npm prune --omit=dev --ignore-scripts \
    && rm -rf node_modules/typescript node_modules/@typescript node_modules/.bin/tsc node_modules/.bin/tsserver
FROM node:26.13.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Package managers are build tools and are not part of the service runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir -p /data && chown node:node /data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8097
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s CMD ["node","--input-type=module","-e","import {loadConfig} from './dist/server/config.js'; const c=loadConfig(); fetch(c.overlayInternalUrl+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"]
CMD ["node","dist/server/main.js"]
