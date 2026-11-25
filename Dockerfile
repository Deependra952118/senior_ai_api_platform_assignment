FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY data ./data
COPY openapi.yaml ./
RUN mkdir -p var && chown node:node var
USER node
EXPOSE 3000 4010
CMD ["node", "src/index.js"]
