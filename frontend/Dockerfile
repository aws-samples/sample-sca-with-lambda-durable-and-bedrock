# Multi-stage build for React application
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including dev dependencies for build)
RUN npm install
RUN npm ci

# Copy source code
COPY . .

# Accept build arguments for React environment variables
ARG REACT_APP_USER_POOL_ID
ARG REACT_APP_USER_POOL_CLIENT_ID
ARG REACT_APP_API_ENDPOINT
ARG REACT_APP_APPSYNC_EVENTS_ENDPOINT
ARG REACT_APP_AWS_REGION

# Set environment variables from build args
ENV REACT_APP_USER_POOL_ID=$REACT_APP_USER_POOL_ID
ENV REACT_APP_USER_POOL_CLIENT_ID=$REACT_APP_USER_POOL_CLIENT_ID
ENV REACT_APP_API_ENDPOINT=$REACT_APP_API_ENDPOINT
ENV REACT_APP_APPSYNC_EVENTS_ENDPOINT=$REACT_APP_APPSYNC_EVENTS_ENDPOINT
ENV REACT_APP_AWS_REGION=$REACT_APP_AWS_REGION

# Build the application with environment variables embedded
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy built application from builder stage
COPY --from=builder /app/build /usr/share/nginx/html

# Copy custom nginx configuration template
COPY nginx.conf /etc/nginx/nginx.conf.template

# Expose port 3000 (to match ECS task configuration)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start nginx with environment variable substitution
CMD ["/bin/sh", "-c", "envsubst '${API_ENDPOINT} ${API_HOST}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf && nginx -g 'daemon off;'"]