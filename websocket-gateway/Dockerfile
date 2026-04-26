# Stage 1: install production dependencies
FROM node:22-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Stage 2: runtime image
FROM node:22-alpine

# Create a non-root user and group
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy production node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY src/ ./src/
COPY package.json ./

# Transfer ownership to the non-root user
RUN chown -R appuser:appgroup /app

USER appuser

# WebSocket server (public)
EXPOSE 8080
# Internal HTTP server (Lambda → Gateway notify)
EXPOSE 8081

CMD ["node", "src/index.js"]
