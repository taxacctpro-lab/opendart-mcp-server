FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
COPY scripts/ scripts/

RUN npm run build

FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist/ dist/
COPY bin/ bin/
COPY bin/ bin/

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
