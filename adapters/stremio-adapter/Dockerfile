FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install && npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
ENV PORT=7000
ENV CORE_URL=http://core:8080
ENV STREMIO_ID=org.streamhub
ENV STREMIO_NAME="StreamHub"
CMD ["node", "dist/index.js"]
