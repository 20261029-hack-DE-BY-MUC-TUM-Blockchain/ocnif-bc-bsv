FROM node:26.13.0-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
RUN npm rebuild better-sqlite3
COPY src ./src
COPY tsconfig.json ./
RUN npm run typecheck
RUN rm -rf node_modules/typescript node_modules/@typescript /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
CMD ["node","--test","src/journal.test.ts","src/overlay.test.ts","src/payment.test.ts","src/swap.test.ts","src/toolbox.test.ts"]
