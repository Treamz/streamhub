FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY static ./static
RUN npm install && npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/static ./static
ENV NODE_ENV=production
ENV PORT=7011
ENV CORE_URL=http://core:8080
CMD ["node", "dist/index.js"]
