FROM node:26.13.0-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY tsconfig.json ./
RUN npm run typecheck
USER node
CMD ["npm","test"]
